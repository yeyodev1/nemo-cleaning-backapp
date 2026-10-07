import crypto from "crypto";
import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import {
  Booking,
  INACTIVE_STATUSES,
  PAYMENT_CONFIRMATIONS,
  PaymentConfirmation,
} from "../models/booking.model";
import { Branch } from "../models/branch.model";
import { nextCode } from "../models/counter.model";
import { Customer } from "../models/customer.model";
import { Payment } from "../models/payment.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { isValidDate, isValidTime, todayStr, toDateTime } from "../utils/date";
import { assertObjectId, cents, escapeRegex, paginated, str } from "../utils/http";
import { RECEIVABLE_MATCH, isSettledWithoutPayment } from "../utils/paymentAccount";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";
import { listPaymentAccounts, methodOfAccount } from "./paymentAccount.service";
import { confirmIfPending, manualTransactionId, recalculatePayments, reviewPayment } from "./payment.service";
import { priceItems } from "./pricing.service";

/**
 * Registro rápido de producción = una fila de la "Base" del Excel: un servicio ya hecho
 * (o uno agendado que se completa). Internamente es un Booking `completed` + su Payment.
 * No manda correos: el servicio ya ocurrió y la mayoría de clientes de la Base no tiene correo.
 */

const POPULATE = [
  { path: "customer", select: "name email phone" },
  { path: "operators", select: "name color" },
];

function parseConfirmation(raw: unknown): PaymentConfirmation {
  const v = String(raw ?? "");
  if (!(PAYMENT_CONFIRMATIONS as readonly string[]).includes(v))
    throw new CustomError("Elige la confirmación del pago", 400);
  return v as PaymentConfirmation;
}

async function parseOperators(raw: unknown): Promise<Types.ObjectId[]> {
  if (!Array.isArray(raw) || !raw.length) throw new CustomError("Elige al menos un operador", 400);
  const ids = [...new Set(raw.map((o: any) => String(o?._id ?? o)))];
  if (ids.some((id) => !isValidObjectId(id))) throw new CustomError("Operador inválido", 400);
  const count = await User.countDocuments({ _id: { $in: ids }, active: true });
  if (count !== ids.length) throw new CustomError("Algún operador no existe o está inactivo", 400);
  return ids.map((id) => new Types.ObjectId(id));
}

/**
 * Cliente elegido del buscador (`_id`) o escrito a mano. Sin id se empareja por
 * teléfono o por el nombre exacto, para no duplicar a quien se registra seguido.
 */
async function resolveCustomer(raw: any, branchId: Types.ObjectId) {
  if (raw?._id) {
    const c = await Customer.findById(assertObjectId(String(raw._id), "el cliente"));
    if (!c) throw new CustomError("Cliente no encontrado", 404);
    return c;
  }
  const name = str(raw?.name, 160);
  const phone = str(raw?.phone, 30);
  if (!name) throw new CustomError("Escribe el nombre del cliente", 400);
  const existing =
    (phone ? await Customer.findOne({ phone }) : null) ??
    (await Customer.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, "i") }));
  if (existing) {
    if (phone && !existing.phone) existing.phone = phone;
    if (!existing.branch) existing.branch = branchId;
    await existing.save();
    return existing;
  }
  return Customer.create({ name, phone, branch: branchId });
}

/** Crea el Payment según la confirmación: confirmado = aprobado; pendiente de confirmación = por revisar. */
async function registerPayment(booking: any, account: string, confirmation: PaymentConfirmation, user: SessionUser) {
  const method = methodOfAccount(account);
  const amount = booking.balance ?? booking.total;
  if (!method || amount <= 0) return;
  if (confirmation !== "confirmed" && confirmation !== "pending_confirmation") return;
  const by = actor(user)!;
  const approved = confirmation === "confirmed";
  await Payment.create({
    booking: booking._id,
    bookingCode: booking.code,
    branch: booking.branch,
    customer: booking.customer,
    amount,
    method,
    account,
    provider: "manual",
    status: approved ? "approved" : "review",
    clientTransactionId: manualTransactionId(booking.code),
    registeredBy: by,
    ...(approved
      ? { reviewedBy: by, reviewedAt: new Date(), paidAt: toDateTime(booking.date, booking.time) }
      : {}),
  });
}

export async function productionOptions(user: SessionUser) {
  const scope = branchFilter(user);
  const branchQuery = scope.branch ? { _id: scope.branch } : {};
  const [accounts, branches, operators] = await Promise.all([
    listPaymentAccounts(),
    Branch.find(branchQuery).select("name zones active").sort({ name: 1 }).lean(),
    User.find({ role: "operator", active: true, ...(scope.branch ? { branches: scope.branch } : {}) })
      .select("name color branches position")
      .sort({ name: 1 })
      .lean(),
  ]);
  return {
    accounts,
    branches: branches.map((b) => ({ _id: String(b._id), name: b.name, zones: b.zones ?? [] })),
    operators: operators.map((o) => ({
      _id: String(o._id),
      name: o.name,
      color: o.color,
      position: o.position ?? "",
      branches: (o.branches ?? []).map(String),
    })),
  };
}

/** POST /admin/production — registro rápido (o completar un pedido agendado con `bookingId`). */
export async function registerProduction(body: any, user: SessionUser) {
  const by = actor(user)!.name;
  const date = body?.date ?? todayStr();
  if (!isValidDate(date)) throw new CustomError("Elige una fecha válida", 400);
  const time = isValidTime(body?.time) ? body.time : "09:00";
  const operators = await parseOperators(body?.operators);
  const confirmation = parseConfirmation(body?.paymentConfirmation);
  const account = str(body?.paymentAccount, 80);
  if (!account) throw new CustomError("Elige la forma de pago", 400);
  const tip = body?.tip !== undefined && body?.tip !== "" ? cents(body.tip, "La propina") : 0;
  const zone = str(body?.zone, 80);
  const notes = str(body?.notes, 1000);
  const discount = body?.discount ? cents(body.discount, "El descuento") : 0;
  const method = methodOfAccount(account) ?? "cash";

  if (body?.bookingId) {
    const booking = await Booking.findById(assertObjectId(String(body.bookingId), "el pedido"));
    if (!booking) throw new CustomError("Pedido no encontrado", 404);
    assertBranchAccess(user, booking.branch);
    if (INACTIVE_STATUSES.includes(booking.status)) throw new CustomError("Ese pedido está cancelado", 409);
    if (Array.isArray(body?.items) && body.items.length) {
      const priced = await priceItems(body.items, { allowInactive: true, allowCustom: true });
      booking.items = priced.items;
      booking.subtotal = priced.subtotal;
      booking.durationMinutes = priced.durationMinutes;
      booking.discount = Math.min(discount, priced.subtotal);
      booking.total = booking.subtotal - booking.discount;
    }
    Object.assign(booking, { date, time, startAt: toDateTime(date, time), operators, zone: zone || booking.zone, tip, paymentAccount: account, paymentConfirmation: confirmation, paymentMethod: method, status: "completed" });
    if (notes) booking.notes = notes;
    booking.history.push({ at: new Date(), by, action: "completed", note: "Completado desde el registro de producción" });
    await booking.save();
    await recalculatePayments(booking._id);
    const fresh = await Booking.findById(booking._id).lean();
    await registerPayment(fresh, account, confirmation, user);
    await recalculatePayments(booking._id);
    return Booking.findById(booking._id).populate(POPULATE).lean();
  }

  const branchId = assertObjectId(String(body?.branch ?? ""), "la sucursal");
  assertBranchAccess(user, branchId);
  const branch = await Branch.findById(branchId);
  if (!branch) throw new CustomError("Sucursal no encontrada", 404);
  const priced = await priceItems(body?.items, { allowInactive: true, allowCustom: true });
  if (discount > priced.subtotal) throw new CustomError("El descuento no puede superar el total", 400);
  const customer = await resolveCustomer(body?.customer, branch._id as Types.ObjectId);
  const code = await nextCode("booking", "NEMO");
  const total = priced.subtotal - discount;
  const booking = await Booking.create({
    code,
    accessToken: crypto.randomBytes(24).toString("hex"),
    branch: branch._id,
    customer: customer._id,
    source: "admin",
    items: priced.items,
    subtotal: priced.subtotal,
    discount,
    total,
    date,
    time,
    startAt: toDateTime(date, time),
    durationMinutes: priced.durationMinutes,
    address: str(body?.address, 300) || customer.address || zone,
    notes,
    status: "completed",
    operators,
    paymentMethod: method,
    paymentStatus: "pending",
    amountPaid: 0,
    balance: total,
    zone,
    tip,
    paymentAccount: account,
    paymentConfirmation: confirmation,
    history: [{ at: new Date(), by, action: "created", note: "Registrado en la producción del día" }],
  });
  await Customer.updateOne({ _id: customer._id }, { $inc: { totalOrders: 1 } });
  await registerPayment(booking, account, confirmation, user);
  await recalculatePayments(booking._id);
  return Booking.findById(booking._id).populate(POPULATE).lean();
}

/**
 * PATCH /admin/bookings/:id/confirmation — cambia la confirmación desde la Base.
 * Pasar a "confirmado" aprueba la transferencia en revisión o registra el cobro del saldo.
 */
export async function setConfirmation(id: string, body: any, user: SessionUser) {
  const booking = await Booking.findById(assertObjectId(id, "el pedido"));
  if (!booking) throw new CustomError("Pedido no encontrado", 404);
  assertBranchAccess(user, booking.branch);
  const confirmation = parseConfirmation(body?.paymentConfirmation);
  const account = body?.paymentAccount !== undefined ? str(body.paymentAccount, 80) : booking.paymentAccount;
  booking.paymentConfirmation = confirmation;
  booking.paymentAccount = account;
  booking.history.push({ at: new Date(), by: actor(user)!.name, action: "updated", note: `Confirmación del pago: ${confirmation}` });
  await booking.save();

  if (confirmation === "confirmed" && booking.balance > 0) {
    const inReview = await Payment.findOne({ booking: booking._id, status: "review", provider: "manual" });
    if (inReview) await reviewPayment(String(inReview._id), { approved: true }, user);
    else {
      await registerPayment(booking, account, "confirmed", user);
      await confirmIfPending(booking._id, actor(user)!.name);
    }
  }
  await recalculatePayments(booking._id);
  return Booking.findById(booking._id).populate(POPULATE).lean();
}

function rowOf(b: any) {
  return {
    _id: String(b._id),
    code: b.code,
    date: b.date,
    time: b.time,
    branch: String(b.branch),
    status: b.status,
    source: b.source ?? "web",
    customer: b.customer ? { _id: String(b.customer._id), name: b.customer.name, phone: b.customer.phone } : null,
    operators: (b.operators ?? []).map((o: any) => ({ _id: String(o._id), name: o.name, color: o.color })),
    zone: b.zone ?? "",
    items: (b.items ?? []).map((i: any) => ({ name: i.name, variant: i.variant, quantity: i.quantity, subtotal: i.subtotal })),
    total: b.total,
    tip: b.tip ?? 0,
    paymentAccount: b.paymentAccount ?? "",
    paymentConfirmation: b.paymentConfirmation ?? "pending_confirmation",
    paymentStatus: b.paymentStatus,
    // Plan mensual / canje / cortesía no dejan deuda: saldo 0 en la hoja.
    balance: isSettledWithoutPayment(b) ? 0 : b.balance,
    settled: isSettledWithoutPayment(b),
    notes: b.notes ?? "",
    novedades: (b.novedades ?? []).length,
  };
}

/** GET /admin/production — la "Base": filas filtrables con totales al pie. */
export async function listProduction(user: SessionUser, query: any) {
  const filter: Record<string, any> = { ...branchFilter(user, query?.branch), status: { $nin: INACTIVE_STATUSES } };
  const from = isValidDate(query?.from) ? query.from : todayStr();
  const to = isValidDate(query?.to) ? query.to : from;
  filter.date = { $gte: from <= to ? from : to, $lte: from <= to ? to : from };
  if (query?.operator && isValidObjectId(String(query.operator))) filter.operators = new Types.ObjectId(String(query.operator));
  if (query?.zone) filter.zone = str(query.zone, 80);
  if (query?.account) filter.paymentAccount = str(query.account, 80);
  if (query?.confirmation && (PAYMENT_CONFIRMATIONS as readonly string[]).includes(String(query.confirmation)))
    filter.paymentConfirmation = String(query.confirmation);
  if (query?.q) {
    const re = new RegExp(escapeRegex(str(query.q, 80)), "i");
    const customers = await Customer.find({ $or: [{ name: re }, { phone: re }] }).select("_id").limit(300).lean();
    filter.$or = [{ code: re }, { customer: { $in: customers.map((c) => c._id) } }];
  }
  // Exportar CSV necesita todo el rango: `all=1` sube el tope.
  const max = query?.all === "1" ? 5000 : 100;
  const limit = Math.min(max, Math.max(1, Math.floor(Number(query?.limit)) || 50));
  const page = Math.max(1, Math.floor(Number(query?.page)) || 1);

  const [items, total, sums, owed] = await Promise.all([
    Booking.find(filter).sort({ date: -1, time: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate(POPULATE).lean(),
    Booking.countDocuments(filter),
    Booking.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$paymentConfirmation",
          count: { $sum: 1 },
          total: { $sum: "$total" },
          tip: { $sum: "$tip" },
          balance: { $sum: "$balance" },
        },
      },
    ]),
    Booking.aggregate<{ _id: string; total: number }>([
      { $match: { ...filter, balance: { $gt: 0 }, paymentConfirmation: { $nin: ["exchange", "lost"] }, paymentAccount: RECEIVABLE_MATCH.paymentAccount } },
      { $group: { _id: { $cond: [{ $eq: ["$paymentStatus", "review"] }, "review", "owed"] }, total: { $sum: "$balance" } } },
    ]),
  ]);
  const byConfirmation: Record<string, { count: number; total: number; balance: number }> = {};
  for (const s of sums)
    byConfirmation[s._id ?? "pending_confirmation"] = { count: s.count, total: s.total, balance: s.balance };
  return {
    ...paginated(items.map(rowOf), total, page, limit),
    from: filter.date.$gte,
    to: filter.date.$lte,
    totals: {
      count: sums.reduce((a, s) => a + s.count, 0),
      production: sums.reduce((a, s) => a + s.total, 0),
      tip: sums.reduce((a, s) => a + s.tip, 0),
      balance: sums.reduce((a, s) => a + s.balance, 0),
      // Por cobrar de verdad: sin plan mensual / canje / cortesía, perdidas ni transferencias en revisión.
      receivable: owed.find((o) => o._id === "owed")?.total ?? 0,
      // Transferencias en revisión: "Por confirmar", no es deuda.
      toConfirm: owed.find((o) => o._id === "review")?.total ?? 0,
      byConfirmation,
    },
  };
}
