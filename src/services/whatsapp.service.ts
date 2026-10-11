import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { Customer } from "../models/customer.model";
import { SessionUser } from "../types/AuthRequest";
import { assertObjectId, cents, str } from "../utils/http";
import { RECEIVABLE_MATCH, SETTLED_ACCOUNT_RE } from "../utils/paymentAccount";
import { assertBranchAccess, branchFilter } from "../utils/scope";
import { changeStatus, createBooking, phoneRegex, updateAdminBooking } from "./booking.service";
import { trackingUrl } from "./bookingEmail.service";
import { addManualPayment } from "./payment.service";
import { listPaymentAccounts, methodOfAccount } from "./paymentAccount.service";

/**
 * "Pedidos por WhatsApp": pedidos que terminan en el chat (la web con "Coordinar y pagar por
 * WhatsApp" o un pedido rápido que carga el asesor). Todo lo que el asesor hace aquí reutiliza
 * las reglas de siempre (editar pedido, cambiar estado, registrar pago): este servicio solo
 * junta los pasos para que se hagan de un toque.
 */

const POPULATE = [
  { path: "customer", select: "name email phone" },
  { path: "operators", select: "name color" },
];
const UNPAID_STATUSES = ["confirmed", "on_the_way", "in_progress", "completed"];
const RECENT_DAYS = 30;
const TABS = ["pending", "unpaid", "recent"] as const;
type Tab = (typeof TABS)[number];

function itemOf(b: any) {
  return {
    _id: String(b._id),
    code: b.code,
    source: b.source,
    // La web deja como primer autor al cliente; el pedido rápido, al asesor.
    fromWeb: b.history?.[0]?.by === "Cliente (web)",
    branch: String(b.branch),
    customer: b.customer
      ? {
          _id: String(b.customer._id),
          name: b.customer.name,
          phone: b.customer.phone,
          email: b.customer.email,
        }
      : null,
    items: (b.items ?? []).map((i: any) => ({
      name: i.name,
      variant: i.variant,
      choice: i.choice ?? "",
      quantity: i.quantity,
      unit: i.unit,
      subtotal: i.subtotal,
    })),
    total: b.total,
    discount: b.discount ?? 0,
    amountPaid: b.amountPaid,
    balance: b.balance,
    date: b.date,
    time: b.time,
    address: b.address,
    reference: b.reference ?? "",
    zone: b.zone ?? "",
    location: b.location ?? null,
    notes: b.notes ?? "",
    status: b.status,
    operators: (b.operators ?? []).map((o: any) => ({
      _id: String(o._id ?? o),
      name: o.name ?? "",
      color: o.color ?? "",
    })),
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    paymentAccount: b.paymentAccount ?? "",
    paymentConfirmation: b.paymentConfirmation,
    trackingUrl: b.accessToken ? trackingUrl(b.code, b.accessToken) : "",
    createdAt: b.createdAt,
  };
}

async function loadItem(id: unknown) {
  const b = await Booking.findById(id).select("+accessToken").populate(POPULATE).lean();
  if (!b) throw new CustomError("Pedido no encontrado", 404);
  return itemOf(b);
}

function tabFilter(tab: Tab): Record<string, any> {
  if (tab === "pending") return { source: "whatsapp", status: "pending" };
  if (tab === "unpaid")
    return { source: "whatsapp", status: { $in: UNPAID_STATUSES }, ...RECEIVABLE_MATCH };
  return { source: "whatsapp", createdAt: { $gte: new Date(Date.now() - RECENT_DAYS * 864e5) } };
}

/** GET /admin/whatsapp/inbox?tab=pending|unpaid|recent&branch= — más nuevos primero. */
export async function inbox(user: SessionUser, query: any) {
  const tab: Tab = (TABS as readonly string[]).includes(String(query?.tab)) ? query.tab : "pending";
  const scope = branchFilter(user, query?.branch);
  const [items, pending, unpaid] = await Promise.all([
    Booking.find({ ...scope, ...tabFilter(tab) })
      .select("+accessToken")
      .sort({ createdAt: -1 })
      .limit(100)
      .populate(POPULATE)
      .lean(),
    Booking.countDocuments({ ...scope, ...tabFilter("pending") }),
    Booking.countDocuments({ ...scope, ...tabFilter("unpaid") }),
  ]);
  return { tab, items: items.map(itemOf), counts: { pending, unpaid } };
}

/** GET /admin/whatsapp/count — para la burbuja del menú (se consulta seguido: solo un conteo). */
export async function pendingCount(user: SessionUser, query: any) {
  const scope = branchFilter(user, query?.branch);
  return { pending: await Booking.countDocuments({ ...scope, ...tabFilter("pending") }) };
}

/**
 * "NEMO-000123", "nemo 123", "#123", "123" o el mensaje de WhatsApp completo → "NEMO-000123".
 * null si no se reconoce un código.
 */
export function parseBookingCode(raw: unknown): string | null {
  const text = String(raw ?? "").toUpperCase();
  const match = text.match(/NEMO[\s\-#]*(\d{1,6})\b/) ?? text.match(/^\D*(\d{1,6})\D*$/);
  return match ? `NEMO-${match[1].padStart(6, "0")}` : null;
}

/** GET /admin/whatsapp/lookup?code= — salta al pedido que el cliente pegó en el chat. */
export async function lookupByCode(user: SessionUser, raw: unknown) {
  const code = parseBookingCode(raw);
  if (!code)
    throw new CustomError("Escribe el código del pedido (por ejemplo NEMO-000123 o 123)", 400);
  const b = await Booking.findOne({ code }).select("+accessToken").populate(POPULATE).lean();
  if (!b) throw new CustomError(`No encontramos el pedido ${code}`, 404);
  assertBranchAccess(user, b.branch);
  return itemOf(b);
}

/**
 * GET /admin/whatsapp/customer?phone= — el pedido rápido empieza por el teléfono: si el cliente
 * ya existe se traen su nombre y los datos de su último pedido (sucursal, urbanización, dirección).
 */
export async function customerByPhone(_user: SessionUser, phoneRaw: unknown) {
  const re = phoneRegex(phoneRaw);
  if (!re) return { customer: null, last: null, others: 0 };
  const found = await Customer.find({ phone: re })
    .sort({ totalOrders: -1, updatedAt: -1 })
    .limit(5)
    .lean();
  const c = found[0];
  if (!c) return { customer: null, last: null, others: 0 };
  const last = await Booking.findOne({ customer: c._id })
    .sort({ createdAt: -1 })
    .select("code branch zone address reference date")
    .lean();
  return {
    customer: {
      _id: String(c._id),
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      totalOrders: c.totalOrders ?? 0,
    },
    last: last
      ? {
          code: last.code,
          date: last.date,
          branch: String(last.branch),
          zone: last.zone ?? "",
          address: last.address ?? "",
          reference: last.reference ?? "",
        }
      : null,
    others: found.length - 1,
  };
}

/** Valida la forma de pago contra las de Configuración; "" = por coordinar. */
async function parseAccount(raw: unknown): Promise<string> {
  const account = str(raw, 80);
  if (!account) return "";
  const accounts = await listPaymentAccounts();
  const hit = accounts.find((a) => a.label.toLowerCase() === account.toLowerCase());
  if (!hit) throw new CustomError("Forma de pago inválida", 400);
  return hit.label;
}

/** Método del pedido según la cuenta: sin cuenta = por coordinar por WhatsApp. */
function methodFor(account: string) {
  if (!account) return "whatsapp";
  return methodOfAccount(account) ?? "cash";
}

/** Canje y Cortesía no se cobran (como en el registro rápido); el resto queda por cobrar hasta que pague. */
function confirmationFor(account: string): string | undefined {
  if (/^\s*(canje|cortes[ií]a)\s*$/i.test(account)) return "exchange";
  if (SETTLED_ACCOUNT_RE.test(account)) return "confirmed";
  return undefined;
}

async function registerPaid(bookingId: string, account: string, raw: any, user: SessionUser) {
  const method = methodOfAccount(account);
  if (!method) {
    throw new CustomError(
      "Para registrar el cobro elige Efectivo, una transferencia o Tarjeta",
      400,
    );
  }
  const b = await Booking.findById(bookingId).select("balance").lean();
  const amount =
    raw?.amount !== undefined && raw?.amount !== "" && raw?.amount !== null
      ? cents(raw.amount, "El monto", { allowZero: false })
      : (b?.balance ?? 0);
  if (amount <= 0) throw new CustomError("Este pedido no tiene saldo por cobrar", 409);
  await addManualPayment(
    bookingId,
    {
      amount,
      method,
      account,
      proofUrl: raw?.proofUrl,
      reference: raw?.reference,
      note: "Registrado desde Pedidos por WhatsApp",
    },
    user,
  );
}

/**
 * POST /admin/whatsapp/orders — pedido rápido de un cliente que escribió directo al WhatsApp.
 * Mismo body que POST /admin/bookings + `paymentAccount` ("" = por coordinar) y `payment`
 * (`{ amount?, proofUrl?, reference? }` si ya pagó). Por defecto queda confirmado: el cliente
 * lo acordó en el chat.
 */
export async function createQuickOrder(body: any, user: SessionUser) {
  const phone = str(body?.customer?.phone, 30);
  if (phone.replace(/\D/g, "").length < 7)
    throw new CustomError("Escribe el WhatsApp del cliente", 400);
  const account = await parseAccount(body?.paymentAccount);
  const status = body?.status === "pending" ? "pending" : "confirmed";
  const { bookingId } = await createBooking(
    {
      ...body,
      paymentMethod: methodFor(account),
      paymentAccount: account,
      paymentConfirmation: confirmationFor(account),
      transferProofUrl: undefined,
      status,
    },
    { source: "whatsapp", user },
  );
  if (body?.payment) await registerPaid(String(bookingId), account, body.payment, user);
  return loadItem(bookingId);
}

/**
 * PATCH /admin/whatsapp/orders/:id — las acciones de un toque de la bandeja, en una sola llamada:
 * `{ paymentAccount?, operators?, payment?: { amount?, proofUrl?, reference? }, confirm? }`.
 * Orden: forma de pago y operadores → cobro (un pago aprobado ya confirma) → confirmar.
 */
export async function handleOrder(id: string, body: any, user: SessionUser) {
  assertObjectId(id, "el pedido");
  const current = await Booking.findById(id).select("branch status paymentAccount").lean();
  if (!current) throw new CustomError("Pedido no encontrado", 404);
  assertBranchAccess(user, current.branch);
  if (["cancelled", "no_show"].includes(current.status))
    throw new CustomError("Este pedido está cancelado", 409);

  const patch: Record<string, unknown> = {};
  let account = current.paymentAccount ?? "";
  if (body?.paymentAccount !== undefined) {
    account = await parseAccount(body.paymentAccount);
    patch.paymentAccount = account;
    patch.paymentMethod = methodFor(account);
    const confirmation = confirmationFor(account);
    if (confirmation) patch.paymentConfirmation = confirmation;
  }
  if (body?.operators !== undefined) patch.operators = body.operators;
  if (Object.keys(patch).length) await updateAdminBooking(id, patch, user);

  if (body?.payment) await registerPaid(id, account, body.payment, user);

  if (body?.confirm) {
    const fresh = await Booking.findById(id).select("status").lean();
    if (fresh?.status === "pending")
      await changeStatus(
        id,
        { status: "confirmed", note: "Confirmado desde Pedidos por WhatsApp" },
        user,
      );
  }
  return loadItem(new Types.ObjectId(id));
}
