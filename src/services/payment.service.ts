import crypto from "crypto";
import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { Customer } from "../models/customer.model";
import { Payment } from "../models/payment.model";
import { SessionUser } from "../types/AuthRequest";
import { dayRange, isValidDate } from "../utils/date";
import { assertObjectId, paginated, parsePage, str } from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";
import { sendPaymentApproved, sendTransferRejected } from "./bookingEmail.service";

// Para la nota del historial, que el panel muestra tal cual.
const METHOD_LABEL: Record<string, string> = { card: "tarjeta", cash: "efectivo", transfer: "transferencia" };

const METHODS = ["card", "cash", "transfer"];

/**
 * Único lugar que calcula lo pagado de un pedido. Se recalcula desde los pagos
 * (no se suma sobre el valor guardado) para que dos operaciones simultáneas no
 * descuadren el saldo.
 */
export async function recalculatePayments(bookingId: unknown) {
  const id = new Types.ObjectId(String(bookingId));
  const [booking, rows] = await Promise.all([
    Booking.findById(id).select("total customer").lean(),
    Payment.aggregate<{ _id: string; total: number; count: number }>([
      { $match: { booking: id } },
      { $group: { _id: "$status", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);
  if (!booking) throw new CustomError("Pedido no encontrado", 404);

  const total = booking.total ?? 0;
  const by = (s: string) => rows.find((r) => r._id === s);
  const amountPaid = by("approved")?.total ?? 0;
  const balance = Math.max(total - amountPaid, 0);

  let paymentStatus: "pending" | "review" | "partial" | "paid" | "refunded" = "pending";
  if (amountPaid > 0) paymentStatus = amountPaid >= total ? "paid" : "partial";
  else if (total === 0 && by("approved")) paymentStatus = "paid";
  else if (by("review")) paymentStatus = "review";
  else if (by("refunded")) paymentStatus = "refunded";
  // Pagado parcial con una transferencia por revisar: se muestra "review" para que caiga en la conciliación.
  if (paymentStatus === "partial" && by("review")) paymentStatus = "review";

  await Booking.updateOne({ _id: id }, { $set: { amountPaid, balance, paymentStatus } });
  await refreshCustomerSpent(booking.customer);
  return { amountPaid, balance, paymentStatus };
}

export async function refreshCustomerSpent(customerId: unknown) {
  if (!customerId) return;
  const id = new Types.ObjectId(String(customerId));
  const [row] = await Payment.aggregate<{ total: number }>([
    { $match: { customer: id, status: "approved" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  await Customer.updateOne({ _id: id }, { $set: { totalSpent: row?.total ?? 0 } });
}

/** Un pago aprobado sobre un pedido pendiente lo confirma. */
export async function confirmIfPending(bookingId: unknown, by: string) {
  await Booking.updateOne(
    { _id: bookingId, status: "pending" },
    {
      $set: { status: "confirmed" },
      $push: {
        history: { at: new Date(), by, action: "confirmed", note: "Confirmado por pago aprobado" },
      },
    },
  );
}

export function manualTransactionId(code: string) {
  return `MANUAL-${code}-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

/** POST /admin/bookings/:id/payments — efectivo, transferencia o tarjeta (datáfono). */
export async function addManualPayment(bookingId: string, body: any, user: SessionUser) {
  assertObjectId(bookingId, "el pedido");
  const amount = Number(body?.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new CustomError("El monto debe ser un entero en centavos mayor a 0", 400);
  }
  const method = String(body?.method ?? "");
  if (!METHODS.includes(method)) throw new CustomError("Método de pago inválido", 400);

  const booking = await Booking.findById(bookingId).select("code status branch customer");
  if (!booking) throw new CustomError("Pedido no encontrado", 404);
  assertBranchAccess(user, booking.branch);
  if (booking.status === "cancelled") {
    throw new CustomError("No se pueden registrar pagos en un pedido cancelado", 409);
  }

  const by = actor(user)!;
  const payment = await Payment.create({
    booking: booking._id,
    bookingCode: booking.code,
    branch: booking.branch,
    customer: booking.customer,
    amount,
    method,
    provider: "manual",
    status: "approved",
    proofUrl: str(body?.proofUrl, 500),
    reference: str(body?.reference, 120),
    account: str(body?.account, 80),
    note: str(body?.note, 500),
    clientTransactionId: manualTransactionId(booking.code),
    registeredBy: by,
    reviewedBy: by,
    reviewedAt: new Date(),
    paidAt: new Date(),
  });
  await Booking.updateOne(
    { _id: booking._id },
    {
      $push: {
        history: {
          at: new Date(),
          by: by.name,
          action: "payment",
          note: `Pago registrado (${METHOD_LABEL[method] ?? method})`,
        },
      },
    },
  );
  await confirmIfPending(booking._id, by.name);
  const totals = await recalculatePayments(booking._id);
  // Cobrado por completo: en la Base deja de figurar como pendiente.
  if (totals.paymentStatus === "paid") {
    await Booking.updateOne(
      { _id: booking._id, paymentConfirmation: { $in: ["pending_confirmation", "pending_payment"] } },
      { $set: { paymentConfirmation: "confirmed" } },
    );
  }
  await sendPaymentApproved(String(booking._id), amount);
  return payment.toObject();
}

export async function listPayments(user: SessionUser, query: any) {
  const { page, limit, skip } = parsePage(query);
  const filter: Record<string, any> = branchFilter(user, query?.branch);
  if (query?.status) filter.status = { $in: String(query.status).split(",") };
  if (query?.method) filter.method = { $in: String(query.method).split(",") };
  if (isValidDate(query?.from) || isValidDate(query?.to)) {
    filter.createdAt = {};
    if (isValidDate(query.from)) filter.createdAt.$gte = dayRange(query.from).start;
    if (isValidDate(query.to)) filter.createdAt.$lt = dayRange(query.to).end;
  }
  const [items, total, sum] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("customer", "name phone email")
      .lean(),
    Payment.countDocuments(filter),
    Payment.aggregate<{ total: number }>([{ $match: filter }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
  ]);
  // Monto del filtro completo (p. ej. todo lo "Por confirmar"), no solo de la página.
  return { ...paginated(items, total, page, limit), totalAmount: sum[0]?.total ?? 0 };
}

/** PATCH /admin/payments/:id/review — conciliación de transferencias. */
export async function reviewPayment(paymentId: string, body: any, user: SessionUser) {
  assertObjectId(paymentId, "el pago");
  if (typeof body?.approved !== "boolean")
    throw new CustomError("Indica si apruebas o rechazas el pago", 400);
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new CustomError("Pago no encontrado", 404);
  assertBranchAccess(user, payment.branch);
  if (!["review", "pending"].includes(payment.status) || payment.provider !== "manual") {
    throw new CustomError("Este pago ya fue revisado", 409);
  }

  const by = actor(user)!;
  const note = str(body?.note, 500);
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: payment.status },
    {
      $set: {
        status: body.approved ? "approved" : "rejected",
        reviewedBy: by,
        reviewedAt: new Date(),
        ...(note ? { note } : {}),
        ...(body.approved ? { paidAt: new Date() } : {}),
      },
    },
    { new: true },
  ).lean();
  if (!claimed) throw new CustomError("Este pago ya fue revisado", 409);

  await Booking.updateOne(
    { _id: payment.booking },
    {
      $push: {
        history: {
          at: new Date(),
          by: by.name,
          action: body.approved ? "payment_approved" : "payment_rejected",
          note: note || (body.approved ? "Transferencia aprobada" : "Transferencia rechazada"),
        },
      },
    },
  );
  if (body.approved) {
    await confirmIfPending(payment.booking, by.name);
    // Columna "Confirmacion" de la Base: la transferencia ya se vio.
    await Booking.updateOne(
      { _id: payment.booking, paymentConfirmation: "pending_confirmation" },
      { $set: { paymentConfirmation: "confirmed" } },
    );
  }
  await recalculatePayments(payment.booking);

  if (body.approved) await sendPaymentApproved(String(payment.booking), claimed.amount);
  else await sendTransferRejected(String(payment.booking), note);
  return claimed;
}
