import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { addDays, dayRange, isValidDate, todayStr, weekDayOf } from "../utils/date";
import { assertObjectId, str } from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";

/** Hoja "NOVEDADES DE LA SEMANA": incidencias por servicio (cliente, operador, novedad). */

async function loadScoped(id: string, user: SessionUser) {
  const booking = await Booking.findById(assertObjectId(id, "la reserva"));
  if (!booking) throw new CustomError("Reserva no encontrada", 404);
  assertBranchAccess(user, booking.branch);
  return booking;
}

export async function addNovedad(bookingId: string, body: any, user: SessionUser) {
  const booking = await loadScoped(bookingId, user);
  const text = str(body?.text, 1000);
  if (!text) throw new CustomError("Escribe qué pasó", 400);
  let operator: Types.ObjectId | null = null;
  if (body?.operator) {
    const id = assertObjectId(String(body.operator), "el operador");
    if (!(await User.exists({ _id: id }))) throw new CustomError("Operador no encontrado", 404);
    operator = new Types.ObjectId(id);
  } else if (booking.operators.length === 1) {
    // Con un solo operador en el servicio, la novedad es suya.
    operator = booking.operators[0];
  }
  const by = actor(user)!;
  booking.novedades.push({ text, operator, by, at: new Date() } as any);
  booking.history.push({ at: new Date(), by: by.name, action: "novedad", note: text.slice(0, 200) });
  await booking.save();
  return booking.novedades[booking.novedades.length - 1];
}

export async function deleteNovedad(bookingId: string, novedadId: string, user: SessionUser) {
  const booking = await loadScoped(bookingId, user);
  assertObjectId(novedadId, "la novedad");
  const before = booking.novedades.length;
  booking.novedades = booking.novedades.filter((n) => String(n._id) !== novedadId) as any;
  if (booking.novedades.length === before) throw new CustomError("Novedad no encontrada", 404);
  await booking.save();
  return { ok: true };
}

/** Semana de lunes a domingo que contiene la fecha. */
function weekOf(date: string) {
  const back = (weekDayOf(date) + 6) % 7;
  const from = addDays(date, -back);
  return { from, to: addDays(from, 6) };
}

/** GET /admin/novedades?from=&to=&branch=&operator= — por defecto la semana en curso. */
export async function listNovedades(user: SessionUser, query: any) {
  const week = weekOf(isValidDate(query?.date) ? query.date : todayStr());
  const from = isValidDate(query?.from) ? query.from : week.from;
  const to = isValidDate(query?.to) ? query.to : week.to;
  const match: Record<string, any> = {
    ...branchFilter(user, query?.branch),
    "novedades.0": { $exists: true },
  };
  const rangeStart = dayRange(from).start;
  const rangeEnd = dayRange(to).end;
  const opFilter =
    query?.operator && isValidObjectId(String(query.operator))
      ? { "novedades.operator": new Types.ObjectId(String(query.operator)) }
      : {};
  const rows = await Booking.aggregate([
    { $match: { ...match, "novedades.at": { $gte: rangeStart, $lt: rangeEnd } } },
    { $unwind: "$novedades" },
    { $match: { "novedades.at": { $gte: rangeStart, $lt: rangeEnd }, ...opFilter } },
    { $sort: { "novedades.at": -1 } },
    { $limit: 500 },
    { $lookup: { from: "customers", localField: "customer", foreignField: "_id", as: "c" } },
    { $lookup: { from: "users", localField: "novedades.operator", foreignField: "_id", as: "o" } },
    {
      $project: {
        _id: "$novedades._id",
        bookingId: "$_id",
        code: 1,
        date: 1,
        branch: 1,
        text: "$novedades.text",
        photos: { $ifNull: ["$novedades.photos", []] },
        at: "$novedades.at",
        by: "$novedades.by",
        customer: { $arrayElemAt: ["$c.name", 0] },
        operator: {
          _id: { $arrayElemAt: ["$o._id", 0] },
          name: { $arrayElemAt: ["$o.name", 0] },
          color: { $arrayElemAt: ["$o.color", 0] },
        },
      },
    },
  ]);
  return {
    from,
    to,
    items: rows.map((r) => ({ ...r, operator: r.operator?._id ? r.operator : null })),
    total: rows.length,
  };
}
