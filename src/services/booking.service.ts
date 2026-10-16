import crypto from "crypto";
import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import {
  BOOKING_STATUSES,
  BOOKING_SOURCES,
  Booking,
  BookingSource,
  BookingStatus,
  IBooking,
  INACTIVE_STATUSES,
  PAYMENT_CONFIRMATIONS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PaymentMethod,
} from "../models/booking.model";
import { Branch } from "../models/branch.model";
import { nextCode } from "../models/counter.model";
import { Customer } from "../models/customer.model";
import { Payment } from "../models/payment.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { RECEIVABLE_MATCH } from "../utils/paymentAccount";
import { isValidDate, isValidTime, todayStr, toDateTime } from "../utils/date";
import {
  EMAIL_RE,
  assertObjectId,
  cents,
  escapeRegex,
  normalizeEmail,
  paginated,
  parsePage,
  str,
} from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";
import { assertSlotAvailable } from "./availability.service";
import {
  sendBookingConfirmed,
  sendBookingCreated,
  sendCancelled,
  sendOperatorAssigned,
  sendRescheduled,
  trackingUrl,
} from "./bookingEmail.service";
import { uploadFile } from "./cloudinary.service";
import { assertPayphoneEnabled, createPayphoneInit, isPayphoneEnabled } from "./payphone.service";
import { manualTransactionId, recalculatePayments } from "./payment.service";
import { priceItems } from "./pricing.service";
import { getSettings } from "./settings.service";

const POPULATE = [
  { path: "customer", select: "name email phone" },
  { path: "operators", select: "name color" },
];
const URL_RE = /^https:\/\/\S+$/i;

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function newAccessToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Etiquetas en español para las notas del historial (el panel las muestra tal cual).
const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  confirmed: "Confirmado",
  on_the_way: "En camino",
  in_progress: "En curso",
  completed: "Terminado",
  cancelled: "Cancelado",
  no_show: "No se presentó",
};

function historyEntry(by: string, action: string, note = "") {
  return { at: new Date(), by, action, note: note.slice(0, 500) };
}

/** `strict` = la web: la factura pide también un teléfono de contacto. El panel completa lo que tenga. */
function parseInvoice(raw: any, { strict = false } = {}) {
  const required = Boolean(raw?.required);
  const invoice = {
    required,
    name: str(raw?.name, 160),
    documentId: str(raw?.documentId, 20),
    email: str(raw?.email, 200).toLowerCase(),
    phone: str(raw?.phone, 30),
    address: str(raw?.address, 300),
  };
  if (required && (!invoice.name || !invoice.documentId)) {
    throw new CustomError("Para la factura escribe el nombre y la cédula o RUC", 400);
  }
  if (required && strict && invoice.phone.replace(/\D/g, "").length < 7) {
    throw new CustomError("Para la factura escribe un teléfono válido", 400);
  }
  return invoice;
}

const MAPS_URL_RE = /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*$/i;

/**
 * Ubicación del servicio: `{ lat, lng, accuracy }` del GPS del celular y/o `url` de Google Maps.
 * null/{} la borra. Fuera de rango o un enlace que no es de Google Maps = 400.
 */
function parseLocation(raw: any) {
  if (raw === null || raw === undefined) return undefined;
  const hasCoords = raw.lat !== undefined && raw.lat !== null && raw.lng !== undefined && raw.lng !== null;
  const url = str(raw.url, 500);
  if (!hasCoords && !url) return undefined;
  let lat: number | null = null;
  let lng: number | null = null;
  if (hasCoords) {
    lat = Number(raw.lat);
    lng = Number(raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new CustomError("La ubicación GPS no es válida", 400);
    }
    // 6 decimales ≈ 10 cm: suficiente y no guarda ruido del sensor.
    lat = Math.round(lat * 1e6) / 1e6;
    lng = Math.round(lng * 1e6) / 1e6;
  }
  if (url && !MAPS_URL_RE.test(url)) {
    throw new CustomError("Pega un enlace de Google Maps (https://maps.app.goo.gl/…)", 400);
  }
  const accuracy = Math.max(0, Math.min(100000, Math.round(Number(raw.accuracy) || 0)));
  return { lat, lng, accuracy: hasCoords ? accuracy : 0, url };
}

/**
 * Regex que encuentra un teléfono escrito de cualquier forma ("0991 234 567", "+593991234567"):
 * compara los últimos 9 dígitos (el celular sin 0 ni 593) dejando pasar separadores.
 * null si no hay dígitos suficientes.
 */
export function phoneRegex(phone: unknown): RegExp | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  const tail = digits.slice(-9);
  return new RegExp(`${tail.split("").join("\\D*")}\\D*$`);
}

/**
 * Busca al cliente por correo (o teléfono) y actualiza sus datos con lo último
 * que escribió: así no se duplica cada vez que vuelve a pedir.
 */
async function upsertCustomer(
  raw: any,
  branchId: Types.ObjectId,
  { strict, accountId }: { strict: boolean; accountId?: string },
) {
  // Con sesión de cliente el pedido va a su cuenta: manda el correo con el que ingresó.
  const account = accountId ? await Customer.findById(accountId) : null;
  const name = str(raw?.name, 160);
  const email = account?.email || normalizeEmail(raw?.email);
  const phone = str(raw?.phone, 30);
  const documentId = str(raw?.documentId, 20);
  if (!name) throw new CustomError("Escribe tu nombre", 400);
  if (email && !EMAIL_RE.test(email)) throw new CustomError("El correo no es válido", 400);
  if (strict && !email) throw new CustomError("Escribe tu correo", 400);
  if (strict && phone.replace(/\D/g, "").length < 7)
    throw new CustomError("Escribe un teléfono válido", 400);
  if (!email && !phone) throw new CustomError("El cliente necesita correo o teléfono", 400);

  // En el panel el teléfono se escribe de cualquier forma: se compara por sus dígitos.
  const byPhone = !strict && phoneRegex(phone);
  const existing =
    account ??
    (email ? await Customer.findOne({ email }) : null) ??
    (phone ? await Customer.findOne({ phone }) : null) ??
    (byPhone ? await Customer.findOne({ phone: byPhone }).sort({ totalOrders: -1 }) : null);
  if (existing) {
    existing.name = name;
    if (email) existing.email = email;
    if (phone) existing.phone = phone;
    if (documentId) existing.documentId = documentId;
    if (!existing.branch) existing.branch = branchId;
    await existing.save();
    return existing;
  }
  return Customer.create({ name, email, phone, documentId, branch: branchId });
}

async function parseOperators(raw: unknown): Promise<Types.ObjectId[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CustomError("operators debe ser una lista", 400);
  const ids = [...new Set(raw.map((o: any) => String(o?._id ?? o)))];
  if (ids.some((id) => !isValidObjectId(id))) throw new CustomError("Operador inválido", 400);
  const count = await User.countDocuments({ _id: { $in: ids }, role: "operator", active: true });
  if (count !== ids.length) throw new CustomError("Algún operador no existe o está inactivo", 400);
  return ids.map((id) => new Types.ObjectId(id));
}

async function populated(id: unknown) {
  return Booking.findById(id).populate(POPULATE).lean();
}

/** Lo que ve el cliente en su enlace de seguimiento: sin historial interno ni token. */
async function publicView(b: any) {
  const [branch, settings, cardPaid] = await Promise.all([
    Branch.findById(b.branch).select("name address phone whatsapp email").lean(),
    getSettings(),
    Payment.exists({ booking: b._id, method: "card", status: "approved" }),
  ]);
  const leadMs = (settings.bookingLeadHours ?? 12) * 60 * 60 * 1000;
  const canCancel =
    ["pending", "confirmed"].includes(b.status) &&
    new Date(b.startAt).getTime() - Date.now() > leadMs &&
    !cardPaid;
  const customer =
    b.customer && typeof b.customer === "object" && "name" in b.customer ? b.customer : null;
  return {
    _id: String(b._id),
    code: b.code,
    branch: String(b.branch),
    branchInfo: branch
      ? {
          _id: String(branch._id),
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
          whatsapp: branch.whatsapp,
          email: branch.email,
        }
      : null,
    customer: customer
      ? {
          _id: String(customer._id),
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
        }
      : null,
    source: b.source,
    items: b.items,
    subtotal: b.subtotal,
    discount: b.discount,
    total: b.total,
    date: b.date,
    time: b.time,
    durationMinutes: b.durationMinutes,
    address: b.address,
    reference: b.reference,
    zone: b.zone ?? "",
    notes: b.notes,
    status: b.status,
    operators: (b.operators ?? []).map((o: any) => ({
      _id: String(o._id ?? o),
      name: o.name ?? "",
      color: o.color ?? "",
    })),
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    amountPaid: b.amountPaid,
    balance: b.balance,
    transferProofUrl: b.transferProofUrl,
    invoice: b.invoice,
    location: b.location ?? null,
    canCancel,
    canPayWithCard:
      isPayphoneEnabled() &&
      b.balance > 0 &&
      !["cancelled", "completed", "no_show"].includes(b.status) &&
      b.paymentStatus !== "review",
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export async function publicViewById(id: unknown) {
  const b = await Booking.findById(id).select("+accessToken").populate(POPULATE).lean();
  if (!b) throw new CustomError("Reserva no encontrada", 404);
  return { booking: await publicView(b), accessToken: b.accessToken };
}

async function findByAccess(codeRaw: unknown, tokenRaw: unknown) {
  const code = String(codeRaw ?? "")
    .trim()
    .toUpperCase();
  const token = String(tokenRaw ?? "").trim();
  const booking = await Booking.findOne({ code }).select("+accessToken");
  // Mismo 404 si no existe o el token no coincide: el enlace no sirve para adivinar códigos.
  if (!booking || !token || !safeEqual(booking.accessToken, token)) {
    throw new CustomError("Reserva no encontrada", 404);
  }
  return booking;
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

interface CreateOptions {
  source: Exclude<BookingSource, "import">;
  /** Personal del panel: sin validar turnos, con líneas libres y descuentos. */
  user?: SessionUser;
  /** Customer con sesión iniciada en la web ("Mi cuenta"). */
  customerId?: string;
  officeQuoteId?: Types.ObjectId;
}

export async function createBooking(body: any, opts: CreateOptions) {
  // Panel = hay sesión del personal (también un pedido rápido por WhatsApp).
  const isAdmin = Boolean(opts.user);
  const byName = opts.user ? actor(opts.user)!.name : "Cliente (web)";

  const branchId = assertObjectId(body?.branch, "la sucursal");
  const branch = await Branch.findById(branchId);
  if (!branch || (!isAdmin && !branch.active)) throw new CustomError("Sucursal no encontrada", 404);
  if (opts.user) assertBranchAccess(opts.user, branch._id);

  const priced = await priceItems(body?.items, { allowInactive: isAdmin, allowCustom: isAdmin });

  const date = body?.date;
  const time = body?.time;
  if (!isValidDate(date)) throw new CustomError("Elige una fecha válida (YYYY-MM-DD)", 400);
  if (!isValidTime(time)) throw new CustomError("Elige una hora válida (HH:mm)", 400);

  const paymentMethod = String(body?.paymentMethod ?? "") as PaymentMethod;
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    throw new CustomError(
      "Elige un método de pago: tarjeta, efectivo, transferencia o coordinar por WhatsApp",
      400,
    );
  }
  const transferProofUrl = str(body?.transferProofUrl, 500);
  if (transferProofUrl && !URL_RE.test(transferProofUrl)) {
    throw new CustomError("El enlace del comprobante no es válido", 400);
  }
  if (paymentMethod === "transfer" && !transferProofUrl && !isAdmin) {
    throw new CustomError("Sube el comprobante de la transferencia", 400);
  }
  if (paymentMethod === "card" && !isAdmin) assertPayphoneEnabled();
  // El panel puede agendar fuera de turno (lo pidió por teléfono el cliente); la web no.
  if (!isAdmin) await assertSlotAvailable(branch, date, time);

  const discount =
    isAdmin && body?.discount !== undefined ? cents(body.discount, "El descuento") : 0;
  if (discount > priced.subtotal)
    throw new CustomError("El descuento no puede superar el subtotal", 400);
  let status: BookingStatus = "pending";
  if (isAdmin && body?.status !== undefined) {
    if (!["pending", "confirmed"].includes(String(body.status))) {
      throw new CustomError("Una reserva nueva solo puede quedar pendiente o confirmada", 400);
    }
    status = body.status;
  }
  const operators = isAdmin ? await parseOperators(body?.operators) : [];
  const invoice = parseInvoice(body?.invoice, { strict: !isAdmin });
  const location = parseLocation(body?.location);
  // En el panel el cliente puede venir elegido por su id (búsqueda por teléfono del pedido rápido).
  const pickedId =
    isAdmin && isValidObjectId(String(body?.customer?._id ?? "")) ? String(body.customer._id) : undefined;
  const customer = await upsertCustomer(body?.customer, branch._id as Types.ObjectId, {
    strict: !isAdmin,
    accountId: isAdmin ? pickedId : opts.customerId,
  });
  const address = str(body?.address, 300) || customer.address;
  if (!address && !isAdmin) throw new CustomError("Escribe la dirección del servicio", 400);
  // Lo último que se usó queda en el cliente: el próximo pedido se llena solo.
  const reference = str(body?.reference, 300);
  if (address) customer.address = address;
  if (reference) customer.reference = reference;
  if (location) customer.location = location;
  if (customer.isModified()) await customer.save();

  let paymentConfirmation: string | undefined;
  if (isAdmin && body?.paymentConfirmation !== undefined) {
    if (!(PAYMENT_CONFIRMATIONS as readonly string[]).includes(String(body.paymentConfirmation)))
      throw new CustomError("Confirmación del pago inválida", 400);
    paymentConfirmation = String(body.paymentConfirmation);
  }
  // Por coordinar = aún no se cobra: en la Base figura como "pendiente de pago".
  if (!paymentConfirmation && paymentMethod === "whatsapp") paymentConfirmation = "pending_payment";

  const code = await nextCode("booking", "NEMO");
  const accessToken = newAccessToken();
  const total = priced.subtotal - discount;
  const createdNote =
    opts.source === "whatsapp"
      ? isAdmin
        ? "Agenda rápida por WhatsApp desde el panel"
        : "Creado desde la web: el cliente termina por WhatsApp"
      : isAdmin
        ? "Creado desde el panel"
        : "Creado desde la web";
  const booking = await Booking.create({
    code,
    accessToken,
    branch: branch._id,
    customer: customer._id,
    source: opts.source,
    items: priced.items,
    subtotal: priced.subtotal,
    discount,
    total,
    date,
    time,
    startAt: toDateTime(date, time),
    durationMinutes: priced.durationMinutes,
    address,
    reference,
    notes: str(body?.notes, 1000),
    // Urbanización elegida en la web (lista de la sucursal o "Otra" escrita a mano).
    zone: str(body?.zone, 80),
    ...(location ? { location } : {}),
    ...(isAdmin && body?.tip !== undefined ? { tip: cents(body.tip, "La propina") } : {}),
    ...(isAdmin && body?.paymentAccount !== undefined ? { paymentAccount: str(body.paymentAccount, 80) } : {}),
    ...(paymentConfirmation ? { paymentConfirmation } : {}),
    status,
    operators,
    paymentMethod,
    paymentStatus: "pending",
    amountPaid: 0,
    balance: total,
    transferProofUrl,
    invoice,
    officeQuote: opts.officeQuoteId ?? null,
    history: [historyEntry(byName, "created", createdNote)],
  });

  // Dos clientes pudieron pedir el último cupo a la vez: se revisa ya guardado y
  // se deshace el propio si se pasó de la capacidad.
  if (!isAdmin) {
    try {
      await assertSlotAvailable(branch, date, time, String(booking._id));
    } catch (error) {
      await Booking.deleteOne({ _id: booking._id });
      throw error;
    }
  }

  await Customer.updateOne({ _id: customer._id }, { $inc: { totalOrders: 1 } });

  if (paymentMethod === "transfer" && transferProofUrl) {
    await Payment.create({
      booking: booking._id,
      bookingCode: code,
      branch: branch._id,
      customer: customer._id,
      amount: total,
      method: "transfer",
      provider: "manual",
      status: "review",
      proofUrl: transferProofUrl,
      clientTransactionId: manualTransactionId(code),
      registeredBy: opts.user ? actor(opts.user) : undefined,
    });
  }
  await recalculatePayments(booking._id);

  let payment: Awaited<ReturnType<typeof createPayphoneInit>> | undefined;
  if (paymentMethod === "card" && !isAdmin && total > 0)
    payment = await createPayphoneInit(booking._id);

  await sendBookingCreated(String(booking._id));
  if (operators.length) await sendOperatorAssigned(String(booking._id), operators.map(String));

  return { bookingId: booking._id, accessToken, payment };
}

export async function createPublicBooking(body: any, customerId?: string) {
  const { bookingId, accessToken, payment } = await createBooking(body, {
    // "Coordinar y pagar por WhatsApp": mismo pedido, pero el asesor lo atiende en el chat.
    source: body?.paymentMethod === "whatsapp" ? "whatsapp" : "web",
    customerId,
  });
  const view = await publicViewById(bookingId);
  return { booking: view.booking, accessToken, ...(payment ? { payment } : {}) };
}

export async function createAdminBooking(body: any, user: SessionUser) {
  const source = body?.source === "whatsapp" ? "whatsapp" : "admin";
  const { bookingId } = await createBooking(body, { source, user });
  return getAdminBooking(String(bookingId), user);
}

// ---------------------------------------------------------------------------
// Público (enlace con token)
// ---------------------------------------------------------------------------

export async function getPublicBooking(code: unknown, token: unknown) {
  const booking = await findByAccess(code, token);
  return publicView(await populated(booking._id));
}

export async function uploadTransferProof(
  code: unknown,
  token: unknown,
  file: Express.Multer.File | undefined,
) {
  const booking = await findByAccess(code, token);
  if (["cancelled", "completed", "no_show"].includes(booking.status)) {
    throw new CustomError("Esta reserva ya no admite pagos", 409);
  }
  if (!(booking.balance > 0)) throw new CustomError("Esta reserva no tiene saldo por pagar", 409);
  const { url } = await uploadFile(file, "comprobantes");

  // Si ya había una transferencia por revisar, se reemplaza su comprobante en vez de duplicarla.
  const pending = await Payment.findOne({
    booking: booking._id,
    method: "transfer",
    status: "review",
  });
  if (pending) {
    pending.proofUrl = url;
    pending.amount = booking.balance;
    await pending.save();
  } else {
    await Payment.create({
      booking: booking._id,
      bookingCode: booking.code,
      branch: booking.branch,
      customer: booking.customer,
      amount: booking.balance,
      method: "transfer",
      provider: "manual",
      status: "review",
      proofUrl: url,
      clientTransactionId: manualTransactionId(booking.code),
    });
  }
  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: { transferProofUrl: url, paymentMethod: "transfer" },
      $push: {
        history: historyEntry(
          "Cliente (web)",
          "transfer_proof",
          "Subió comprobante de transferencia",
        ),
      },
    },
  );
  await recalculatePayments(booking._id);
  return publicView(await populated(booking._id));
}

export async function cancelPublicBooking(code: unknown, token: unknown, reasonRaw: unknown) {
  const booking = await findByAccess(code, token);
  const view = await publicView(await populated(booking._id));
  if (!view.canCancel) {
    throw new CustomError(
      "Esta reserva ya no se puede cancelar en línea. Escríbenos por WhatsApp para ayudarte",
      409,
    );
  }
  const reason = str(reasonRaw, 300);
  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: { status: "cancelled" },
      $push: {
        history: historyEntry("Cliente (web)", "cancelled", reason || "Cancelado por el cliente"),
      },
    },
  );
  // Los intentos de tarjeta sin confirmar ya no sirven.
  await Payment.updateMany(
    { booking: booking._id, provider: "payphone", status: "pending" },
    { $set: { status: "rejected" } },
  );
  await sendCancelled(String(booking._id), reason);
  return publicView(await populated(booking._id));
}

export async function restartPayphone(code: unknown, token: unknown) {
  const booking = await findByAccess(code, token);
  if (booking.paymentStatus === "review") {
    throw new CustomError("Tu transferencia está en revisión. Espera la confirmación", 409);
  }
  const init = await createPayphoneInit(booking._id);
  if (booking.paymentMethod !== "card") {
    await Booking.updateOne({ _id: booking._id }, { $set: { paymentMethod: "card" } });
  }
  return init;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

async function loadScoped(id: string, user: SessionUser) {
  assertObjectId(id, "la reserva");
  const booking = await Booking.findById(id);
  if (!booking) throw new CustomError("Reserva no encontrada", 404);
  assertBranchAccess(user, booking.branch);
  return booking;
}

export async function listBookings(user: SessionUser, query: any) {
  const { page, limit, skip } = parsePage(query);
  const filter: Record<string, any> = branchFilter(user, query?.branch);
  if (query?.status)
    filter.status = {
      $in: String(query.status)
        .split(",")
        .filter((s) => (BOOKING_STATUSES as readonly string[]).includes(s)),
    };
  if (query?.paymentStatus) {
    filter.paymentStatus = {
      $in: String(query.paymentStatus)
        .split(",")
        .filter((s) => (PAYMENT_STATUSES as readonly string[]).includes(s)),
    };
  }
  if (query?.paymentMethod) filter.paymentMethod = { $in: String(query.paymentMethod).split(",") };
  if (isValidDate(query?.date)) filter.date = query.date;
  else if (isValidDate(query?.from) || isValidDate(query?.to)) {
    filter.date = {};
    if (isValidDate(query.from)) filter.date.$gte = query.from;
    if (isValidDate(query.to)) filter.date.$lte = query.to;
  }
  if (query?.operator && isValidObjectId(String(query.operator)))
    filter.operators = new Types.ObjectId(String(query.operator));
  if (query?.customer && isValidObjectId(String(query.customer)))
    filter.customer = new Types.ObjectId(String(query.customer));
  if ((BOOKING_SOURCES as readonly string[]).includes(String(query?.source ?? "")))
    filter.source = query.source;
  if (query?.q) {
    const q = str(query.q, 80);
    const re = new RegExp(escapeRegex(q), "i");
    const customers = await Customer.find({
      $or: [{ name: re }, { email: re }, { phone: re }, { documentId: re }],
    })
      .select("_id")
      .limit(200)
      .lean();
    filter.$or = [{ code: re }, { customer: { $in: customers.map((c) => c._id) } }];
  }
  const sort: Record<string, 1 | -1> = query?.sort === "asc" ? { startAt: 1 } : { startAt: -1 };
  const [items, total] = await Promise.all([
    Booking.find(filter).sort(sort).skip(skip).limit(limit).populate(POPULATE).lean(),
    Booking.countDocuments(filter),
  ]);
  return paginated(items, total, page, limit);
}

export async function getAgenda(user: SessionUser, query: any) {
  const date = isValidDate(query?.date) ? query.date : todayStr();
  // Semana o mes: `from`/`to` (máx. 42 días, lo que muestra la grilla del mes).
  let dateFilter: string | { $gte: string; $lte: string } = date;
  if (isValidDate(query?.from) && isValidDate(query?.to) && query.from <= query.to) {
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
    if (days > 42) throw new CustomError("El rango de la agenda es de máximo 6 semanas", 400);
    dateFilter = { $gte: query.from, $lte: query.to };
  }
  const scope = branchFilter(user, query?.branch);
  const opFilter: Record<string, any> = { role: "operator", active: true };
  if (scope.branch) opFilter.branches = scope.branch;
  const [operators, bookings] = await Promise.all([
    User.find(opFilter).select("name color phone branches").sort({ name: 1 }).lean(),
    Booking.find({ ...scope, date: dateFilter })
      .sort({ date: 1, time: 1 })
      .populate(POPULATE)
      .lean(),
  ]);
  return {
    date,
    operators: operators.map((o) => ({
      _id: String(o._id),
      name: o.name,
      color: o.color,
      phone: o.phone,
      branches: o.branches.map(String),
    })),
    bookings,
  };
}

export async function getAdminBooking(id: string, user: SessionUser) {
  assertObjectId(id, "la reserva");
  const booking = await Booking.findById(id).select("+accessToken").populate(POPULATE).lean();
  if (!booking) throw new CustomError("Reserva no encontrada", 404);
  assertBranchAccess(user, booking.branch);
  const payments = await Payment.find({ booking: booking._id }).sort({ createdAt: -1 }).lean();
  const { accessToken, ...rest } = booking;
  // El enlace de seguimiento sirve para mandarlo por WhatsApp desde el panel.
  return { ...rest, trackingUrl: trackingUrl(booking.code, accessToken), payments };
}

export async function updateAdminBooking(id: string, body: any, user: SessionUser) {
  const booking = await loadScoped(id, user);
  const by = actor(user)!.name;
  const notes: string[] = [];

  if (body?.branch !== undefined && String(body.branch) !== String(booking.branch)) {
    const branchId = assertObjectId(body.branch, "la sucursal");
    assertBranchAccess(user, branchId);
    if (!(await Branch.exists({ _id: branchId })))
      throw new CustomError("Sucursal no encontrada", 404);
    booking.branch = new Types.ObjectId(branchId);
    notes.push("Cambio de sucursal");
  }

  if (body?.items !== undefined) {
    const priced = await priceItems(body.items, { allowInactive: true, allowCustom: true });
    booking.items = priced.items;
    booking.subtotal = priced.subtotal;
    booking.durationMinutes = priced.durationMinutes;
    notes.push("Servicios actualizados");
  }
  if (body?.discount !== undefined) {
    booking.discount = cents(body.discount, "El descuento");
    notes.push("Descuento actualizado");
  }
  if (booking.discount > booking.subtotal)
    throw new CustomError("El descuento no puede superar el subtotal", 400);
  booking.total = booking.subtotal - booking.discount;

  const previous = { date: booking.date, time: booking.time };
  if (body?.date !== undefined || body?.time !== undefined) {
    const date = body?.date ?? booking.date;
    const time = body?.time ?? booking.time;
    if (!isValidDate(date)) throw new CustomError("Fecha inválida (YYYY-MM-DD)", 400);
    if (!isValidTime(time)) throw new CustomError("Hora inválida (HH:mm)", 400);
    booking.date = date;
    booking.time = time;
    booking.startAt = toDateTime(date, time);
  }
  const rescheduled = previous.date !== booking.date || previous.time !== booking.time;
  if (rescheduled)
    notes.push(
      `Reprogramado de ${previous.date} ${previous.time} a ${booking.date} ${booking.time}`,
    );

  for (const key of ["address", "reference"] as const) {
    if (body?.[key] !== undefined) booking[key] = str(body[key], 300);
  }
  if (body?.notes !== undefined) booking.notes = str(body.notes, 1000);
  if (body?.zone !== undefined) booking.zone = str(body.zone, 80);
  if (body?.tip !== undefined) booking.tip = cents(body.tip, "La propina");
  if (body?.paymentAccount !== undefined) booking.paymentAccount = str(body.paymentAccount, 80);
  if (body?.paymentConfirmation !== undefined) {
    if (!(PAYMENT_CONFIRMATIONS as readonly string[]).includes(String(body.paymentConfirmation)))
      throw new CustomError("Confirmación del pago inválida", 400);
    booking.paymentConfirmation = body.paymentConfirmation;
  }
  if (body?.invoice !== undefined) booking.invoice = parseInvoice(body.invoice);
  if (body?.location !== undefined) booking.location = parseLocation(body.location);
  if (body?.paymentMethod !== undefined) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(String(body.paymentMethod))) {
      throw new CustomError("Método de pago inválido", 400);
    }
    booking.paymentMethod = body.paymentMethod;
  }
  if (body?.transferProofUrl !== undefined) {
    const url = str(body.transferProofUrl, 500);
    if (url && !URL_RE.test(url))
      throw new CustomError("El enlace del comprobante no es válido", 400);
    booking.transferProofUrl = url;
  }

  let newOperators: string[] = [];
  if (body?.operators !== undefined) {
    const before = new Set(booking.operators.map(String));
    const ops = await parseOperators(body.operators);
    newOperators = ops.map(String).filter((o) => !before.has(o));
    booking.operators = ops;
    notes.push(ops.length ? "Operadores asignados" : "Operadores retirados");
  }

  booking.history.push(
    historyEntry(by, rescheduled ? "rescheduled" : "updated", notes.join(". ") || "Reserva editada"),
  );
  await booking.save();
  await recalculatePayments(booking._id);

  if (rescheduled) await sendRescheduled(String(booking._id), previous);
  if (newOperators.length) await sendOperatorAssigned(String(booking._id), newOperators);
  return getAdminBooking(String(booking._id), user);
}

export async function changeStatus(id: string, body: any, user: SessionUser) {
  const status = String(body?.status ?? "") as BookingStatus;
  if (!(BOOKING_STATUSES as readonly string[]).includes(status))
    throw new CustomError("Estado inválido", 400);
  const booking = await loadScoped(id, user);
  if (booking.status === status) return getAdminBooking(id, user);
  const note = str(body?.note, 500);
  const previous = booking.status;
  booking.status = status;
  booking.history.push(
    historyEntry(actor(user)!.name, status, note || `Estado: ${STATUS_LABEL[previous] ?? previous} → ${STATUS_LABEL[status] ?? status}`),
  );
  await booking.save();
  if (status === "cancelled") {
    await Payment.updateMany(
      { booking: booking._id, provider: "payphone", status: "pending" },
      { $set: { status: "rejected" } },
    );
    await sendCancelled(String(booking._id), note);
  }
  if (status === "confirmed" && previous === "pending")
    await sendBookingConfirmed(String(booking._id));
  return getAdminBooking(id, user);
}

export async function listReceivables(user: SessionUser, query: any) {
  const filter = {
    ...branchFilter(user, query?.branch),
    status: { $in: ["confirmed", "completed"] },
    // Sin plan mensual / canje / cortesía, perdidas ni transferencias en revisión.
    ...RECEIVABLE_MATCH,
  };
  // Con el historial importado son miles de filas: solo los campos que pinta la pestaña CxC.
  const items = await Booking.find(filter)
    .select("code date time total balance amountPaid status paymentStatus customer branch paymentConfirmation paymentAccount")
    .sort({ startAt: 1 })
    .populate("customer", "name phone")
    .lean();
  return { items, total: items.length, totalBalance: items.reduce((s, b) => s + b.balance, 0) };
}

// ---------------------------------------------------------------------------
// Operador (lavador)
// ---------------------------------------------------------------------------

export type { IBooking };
