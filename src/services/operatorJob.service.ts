import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking, BookingStatus } from "../models/booking.model";
import { HALF_DAY_UNTIL, Shift } from "../models/shift.model";
import { SessionUser } from "../types/AuthRequest";
import { isValidDate, todayStr } from "../utils/date";
import { assertObjectId, str } from "../utils/http";

/**
 * Panel del operador (lavador): ve su turno, la hora, a dónde ir y qué hacer.
 * Nunca recibe montos (total, saldo, pagos, propina ni precios).
 */

const OPERATOR_STATUSES: BookingStatus[] = ["on_the_way", "in_progress", "completed"];
const INACTIVE = ["cancelled", "no_show"];
const MAX_PHOTOS = 8;
const PHOTO_URL_RE = /^https:\/\/res\.cloudinary\.com\/\S+$/;

const POPULATE_JOB = [
  { path: "customer", select: "name phone" },
  { path: "operators", select: "name color" },
  { path: "branch", select: "name address phone" },
];

/** Solo lo que necesita para trabajar: sin dinero ni historial interno. */
function toJob(b: any) {
  return {
    _id: String(b._id),
    code: b.code,
    date: b.date,
    time: b.time,
    durationMinutes: b.durationMinutes,
    status: b.status,
    customer: b.customer ? { name: b.customer.name, phone: b.customer.phone } : null,
    branch: b.branch ? { name: b.branch.name, address: b.branch.address, phone: b.branch.phone } : null,
    address: b.address ?? "",
    reference: b.reference ?? "",
    zone: b.zone ?? "",
    location: b.location ?? null,
    notes: b.notes ?? "",
    items: (b.items ?? []).map((i: any) => ({ name: i.name, variant: i.variant ?? "", choice: i.choice ?? "", unit: i.unit, quantity: i.quantity })),
    operators: (b.operators ?? []).map((o: any) => ({ _id: String(o._id), name: o.name, color: o.color })),
    startCheck: b.startCheck ? { at: b.startCheck.at, accuracy: b.startCheck.accuracy } : null,
    // Lo que él mismo reportó al terminar (no el total del servicio).
    closeReport: b.closeReport ? { method: b.closeReport.method, cashReceived: b.closeReport.cashReceived, at: b.closeReport.at } : null,
    novedades: (b.novedades ?? []).map((n: any) => ({
      _id: String(n._id),
      text: n.text ?? "",
      photos: n.photos ?? [],
      by: n.by?.name ?? "",
      at: n.at,
    })),
  };
}

async function loadMine(id: string, user: SessionUser) {
  const booking = await Booking.findById(assertObjectId(id, "el servicio"));
  if (!booking) throw new CustomError("Servicio no encontrado", 404);
  if (!booking.operators.map(String).includes(user.id)) {
    throw new CustomError("Este servicio no está asignado a ti", 403);
  }
  if (INACTIVE.includes(booking.status)) throw new CustomError("Este servicio fue cancelado", 409);
  return booking;
}

async function fresh(id: unknown) {
  return toJob(await Booking.findById(id).populate(POPULATE_JOB).lean());
}

/** GET /operator/bookings?date= — turno del día y sus servicios en orden de hora. */
export async function myJobs(user: SessionUser, query: any) {
  const date = isValidDate(query?.date) ? query.date : todayStr();
  const operator = new Types.ObjectId(user.id);
  const [shift, bookings] = await Promise.all([
    Shift.findOne({ operator, date }).select("status").lean(),
    Booking.find({ operators: operator, date, status: { $nin: INACTIVE } })
      .sort({ time: 1 })
      .populate(POPULATE_JOB)
      .lean(),
  ]);
  // Sin registro en el calendario de turnos = ACTIVO.
  return {
    date,
    shift: { status: shift?.status ?? "active", halfDayUntil: HALF_DAY_UNTIL },
    bookings: bookings.map(toJob),
  };
}

function parseStartLocation(raw: any) {
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    throw new CustomError("Para iniciar necesitamos tu ubicación. Activa el GPS y vuelve a intentar", 400);
  }
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    accuracy: Math.max(0, Math.min(100000, Math.round(Number(raw?.accuracy) || 0))),
  };
}

/** PATCH /operator/bookings/:id/status — iniciar exige la ubicación (se marca una sola vez). */
export async function changeJobStatus(id: string, body: any, user: SessionUser) {
  const status = String(body?.status ?? "") as BookingStatus;
  if (!OPERATOR_STATUSES.includes(status)) {
    throw new CustomError("Estado inválido: usa on_the_way, in_progress o completed", 400);
  }
  const booking = await loadMine(id, user);
  const by = { id: user.id, name: user.name || user.email };
  if (status === "in_progress" && !booking.startCheck) {
    booking.startCheck = { ...parseStartLocation(body?.location), at: new Date(), by } as any;
  }
  if (status === "completed" && !booking.startCheck) {
    throw new CustomError("Primero inicia el servicio (marca tu ubicación al llegar)", 409);
  }
  if (status === "completed") {
    const method = String(body?.payment?.method ?? "");
    if (method !== "cash" && method !== "transfer") {
      throw new CustomError("Indica si el cliente pagó en efectivo o por transferencia", 400);
    }
    let cashReceived = 0;
    if (method === "cash") {
      cashReceived = Number(body?.payment?.cashReceived);
      if (!Number.isInteger(cashReceived) || cashReceived < 0 || cashReceived > 10_000_000) {
        throw new CustomError("Escribe cuánto efectivo recibiste", 400);
      }
    }
    booking.closeReport = { method, cashReceived, at: new Date(), by } as any;
  }
  const note = str(body?.note, 500);
  booking.status = status;
  const closeNote = booking.closeReport && status === "completed"
    ? booking.closeReport.method === "cash"
      ? `Cobró en efectivo: $${(booking.closeReport.cashReceived / 100).toFixed(2)}`
      : "El cliente pagó por transferencia"
    : "";
  booking.history.push({ at: new Date(), by: by.name, action: status, note: [closeNote, note].filter(Boolean).join(" · ") });
  await booking.save();
  return fresh(booking._id);
}

/** POST /operator/bookings/:id/novedades — observación del servicio con fotos. */
export async function addJobNovedad(id: string, body: any, user: SessionUser) {
  const booking = await loadMine(id, user);
  const text = str(body?.text, 1000);
  const photos: string[] = Array.isArray(body?.photos) ? body.photos.map((p: unknown) => String(p)).filter((p: string) => PHOTO_URL_RE.test(p)) : [];
  if (photos.length > MAX_PHOTOS) throw new CustomError(`Máximo ${MAX_PHOTOS} fotos por novedad`, 400);
  if (!text && !photos.length) throw new CustomError("Escribe qué pasó o agrega una foto", 400);
  const by = { id: user.id, name: user.name || user.email };
  booking.novedades.push({ text, photos, operator: new Types.ObjectId(user.id), by, at: new Date() } as any);
  booking.history.push({ at: new Date(), by: by.name, action: "novedad", note: (text || `${photos.length} foto(s)`).slice(0, 200) });
  await booking.save();
  return fresh(booking._id);
}
