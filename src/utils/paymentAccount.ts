/**
 * Cuenta a la que entró un pago, con los nombres de la columna "Pagos" del Excel
 * ("Transferencia Pichincha", "Efectivo", "Tarjeta (Payphone)"…). Se toma la del pago si
 * la tiene y si no la del pedido; una transferencia sin cuenta queda visible como tal para
 * que se corrija en vez de perderse en un total.
 */
export const CASH_ACCOUNT = "Efectivo";
export const CARD_ACCOUNT = "Tarjeta (Payphone)";
export const NO_ACCOUNT = "Transferencia sin cuenta";

export function accountLabel(
  payment: { method?: string; account?: unknown },
  booking?: { paymentAccount?: unknown } | null,
): string {
  if (payment.method === "cash") return CASH_ACCOUNT;
  const own = typeof payment.account === "string" ? payment.account.trim() : "";
  if (own) return own;
  const fromBooking = typeof booking?.paymentAccount === "string" ? booking.paymentAccount.trim() : "";
  // El pedido puede decir "Efectivo" aunque el pago fue con tarjeta: manda el método del pago.
  if (fromBooking && !/^efectivo$/i.test(fromBooking)) {
    if (payment.method === "card" && !/tarjeta|payphone/i.test(fromBooking)) return CARD_ACCOUNT;
    return fromBooking;
  }
  return payment.method === "card" ? CARD_ACCOUNT : NO_ACCOUNT;
}

/**
 * Confirmación del pago del pedido normalizada para los reportes: "exchange" (canje, no
 * se cobra), "lost" (perdida, no se cobrará) o "" para el resto. Un pedido con forma de
 * pago "Canje" cuenta como canje aunque no tenga la confirmación marcada.
 */
export function confirmationOf(booking: { paymentConfirmation?: unknown; paymentAccount?: unknown }): string {
  const c = typeof booking.paymentConfirmation === "string" ? booking.paymentConfirmation : "";
  if (c === "exchange" || c === "lost") return c;
  // Canje, Cortesía y Plan mensual (prepagado) no se cobran pedido a pedido.
  if (typeof booking.paymentAccount === "string" && SETTLED_ACCOUNT_RE.test(booking.paymentAccount))
    return "exchange";
  return "";
}

export function tipOf(booking: { tip?: unknown }): number {
  const n = Number(booking.tip);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Pedidos que no dejan deuda aunque no tengan un pago registrado: "Plan mensual" (prepagado
 * en el plan), "Canje" y "Cortesía". No son cuentas por cobrar ni su saldo cuenta como deuda.
 */
export const SETTLED_ACCOUNT_RE = /^\s*(plan mensual|canje|cortes[ií]a)\s*$/i;

export function isSettledWithoutPayment(booking: { paymentConfirmation?: unknown; paymentAccount?: unknown }) {
  if (booking.paymentConfirmation === "exchange") return true;
  return typeof booking.paymentAccount === "string" && SETTLED_ACCOUNT_RE.test(booking.paymentAccount);
}

/**
 * Filtro Mongo de lo que SÍ es "Por cobrar": saldo > 0, sin plan mensual / canje / cortesía,
 * sin perdidas (van aparte) y sin transferencias en revisión (eso es "Por confirmar").
 */
export const RECEIVABLE_MATCH = {
  balance: { $gt: 0 },
  paymentConfirmation: { $nin: ["exchange", "lost"] },
  paymentAccount: { $not: SETTLED_ACCOUNT_RE },
  paymentStatus: { $ne: "review" },
};
