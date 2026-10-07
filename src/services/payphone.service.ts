import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { Customer } from "../models/customer.model";
import { Payment } from "../models/payment.model";
import { toInternationalPhone } from "../utils/http";
import { sendPaymentApproved } from "./bookingEmail.service";
import { CARD_ACCOUNT } from "../utils/paymentAccount";
import { confirmIfPending, recalculatePayments } from "./payment.service";

const CONFIRM_URL = "https://paymentbox.payphonetodoesposible.com/api/confirm";

export function isPayphoneEnabled(): boolean {
  return Boolean(env.PAYPHONE_TOKEN && env.PAYPHONE_STORE_ID);
}

export function assertPayphoneEnabled() {
  if (!isPayphoneEnabled()) throw new CustomError("El pago con tarjeta aún no está activo", 503);
}

/** Único por intento y ≤ 50 caracteres (límite de Payphone). */
function newClientTransactionId(code: string): string {
  const base = code
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 20);
  return `${base}-${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`.slice(0, 50);
}

/**
 * Prepara un intento de cobro con la Cajita de Pagos. Cada intento es un Payment
 * "pending" con su clientTransactionId; el que Payphone confirme es el que vale.
 */
export async function createPayphoneInit(bookingId: unknown) {
  assertPayphoneEnabled();
  const booking = await Booking.findById(bookingId).select(
    "code balance total branch customer status",
  );
  if (!booking) throw new CustomError("Pedido no encontrado", 404);
  if (["cancelled", "completed", "no_show"].includes(booking.status)) {
    throw new CustomError("Este pedido ya no admite pagos", 409);
  }
  const amount = booking.balance;
  if (!(amount > 0)) throw new CustomError("Este pedido no tiene saldo por pagar", 409);

  const customer = await Customer.findById(booking.customer).lean();
  const clientTransactionId = newClientTransactionId(booking.code);
  await Payment.create({
    booking: booking._id,
    bookingCode: booking.code,
    branch: booking.branch,
    customer: booking.customer,
    amount,
    method: "card",
    provider: "payphone",
    status: "pending",
    clientTransactionId,
  });

  return {
    token: env.PAYPHONE_TOKEN,
    storeId: env.PAYPHONE_STORE_ID,
    clientTransactionId,
    amount,
    amountWithoutTax: amount,
    amountWithTax: 0,
    tax: 0,
    currency: "USD",
    reference: `Pedido ${booking.code}`.slice(0, 100),
    email: customer?.email ?? "",
    phoneNumber: toInternationalPhone(customer?.phone ?? ""),
    documentId: customer?.documentId ?? "",
  };
}

async function publicResult(status: "approved" | "rejected", bookingId: unknown, message: string) {
  // Import diferido: booking.service importa este módulo.
  const { publicViewById } = await import("./booking.service");
  const { booking, accessToken } = await publicViewById(bookingId);
  return { status, booking, accessToken, message };
}

/**
 * POST /public/payphone/confirm. Idempotente: la página de respuesta se recarga
 * más de lo que uno cree, y un pago ya resuelto devuelve el mismo resultado.
 */
export async function confirmPayphone(body: any) {
  const id = Number(body?.id);
  const clientTransactionId = String(body?.clientTransactionId ?? "").trim();
  if (!Number.isFinite(id) || id <= 0 || !clientTransactionId) {
    throw new CustomError("Faltan los datos de la transacción", 400);
  }

  const payment = await Payment.findOne({ clientTransactionId, provider: "payphone" });
  if (!payment) throw new CustomError("No se encontró el pago", 404);

  if (payment.status === "approved")
    return publicResult("approved", payment.booking, "Pago aprobado");
  if (payment.status === "rejected")
    return publicResult("rejected", payment.booking, "El pago no fue aprobado");

  assertPayphoneEnabled();

  let data: any;
  try {
    const response = await axios.post(
      CONFIRM_URL,
      { id, clientTxId: clientTransactionId },
      { headers: { Authorization: `Bearer ${env.PAYPHONE_TOKEN}` }, timeout: 20000 },
    );
    data = response.data;
  } catch (error: any) {
    const providerData = error?.response?.data;
    if (providerData) {
      // Error funcional de Payphone: el pago queda pendiente por si el cliente reintenta.
      await Payment.updateOne(
        { _id: payment._id, status: "pending" },
        { $set: { providerResponse: providerData } },
      );
      return publicResult(
        "rejected",
        payment.booking,
        providerData.message || "Payphone no pudo confirmar el pago",
      );
    }
    throw new CustomError(
      "No se pudo contactar a Payphone. Intenta de nuevo en unos segundos",
      502,
    );
  }

  const statusCode = Number(data?.statusCode);
  if (statusCode !== 3) {
    await Payment.updateOne(
      { _id: payment._id, status: "pending" },
      {
        $set: {
          status: "rejected",
          providerResponse: data,
          transactionId: String(data?.transactionId ?? id),
        },
      },
    );
    return publicResult("rejected", payment.booking, data?.message || "El pago no fue aprobado");
  }

  if (Number(data.amount) !== payment.amount) {
    await Payment.updateOne(
      { _id: payment._id, status: "pending" },
      { $set: { status: "rejected", providerResponse: data, note: "Monto distinto al esperado" } },
    );
    console.error(
      `[payphone] monto distinto en ${clientTransactionId}: esperado ${payment.amount}, recibido ${data.amount}`,
    );
    return publicResult(
      "rejected",
      payment.booking,
      "El monto cobrado no coincide con el pedido. Contáctanos",
    );
  }

  // Reclamo atómico: si dos confirmaciones llegan juntas, solo una aplica efectos.
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    {
      $set: {
        status: "approved",
        paidAt: new Date(),
        reviewedAt: new Date(),
        transactionId: String(data.transactionId ?? id),
        reference: String(data.authorizationCode ?? ""),
        providerResponse: data,
      },
    },
    { new: true },
  );
  if (!claimed) return publicResult("approved", payment.booking, "Pago aprobado");

  await Booking.updateOne(
    { _id: payment.booking },
    {
      $push: {
        history: {
          at: new Date(),
          by: "Payphone",
          action: "payment_approved",
          note: "Pago con tarjeta aprobado",
        },
      },
    },
  );
  await confirmIfPending(payment.booking, "Payphone");
  const totals = await recalculatePayments(payment.booking);
  // Pagado con el enlace (p. ej. un pedido por WhatsApp "por coordinar"): queda confirmado
  // en la Base y con la cuenta de tarjeta, sin que el asesor tenga que tocar nada.
  if (totals.paymentStatus === "paid") {
    await Booking.updateOne(
      { _id: payment.booking, paymentConfirmation: { $in: ["pending_confirmation", "pending_payment"] } },
      { $set: { paymentConfirmation: "confirmed" } },
    );
    await Booking.updateOne(
      { _id: payment.booking, paymentAccount: "" },
      { $set: { paymentAccount: CARD_ACCOUNT } },
    );
  }
  await sendPaymentApproved(String(payment.booking), claimed.amount);
  return publicResult("approved", payment.booking, "Pago aprobado");
}
