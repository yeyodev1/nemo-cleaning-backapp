import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { BankStatement } from "../models/bankStatement.model";
import { Booking } from "../models/booking.model";
import { Payment } from "../models/payment.model";
import { SessionUser } from "../types/AuthRequest";
import { dateStrOf, isValidDate, parseRange } from "../utils/date";
import { assertObjectId, cents, str } from "../utils/http";
import { NO_ACCOUNT, accountLabel } from "../utils/paymentAccount";
import { actor, branchFilter } from "../utils/scope";
import { listPaymentAccounts } from "./paymentAccount.service";

/**
 * Conciliación bancaria (hoja "CONCILIACIÓN": total en cuentas de la semana). Para el
 * periodo (semana o quincena) y cada cuenta: lo registrado en el panel (pagos aprobados con
 * transferencia o tarjeta, por fecha de pago), lo ya verificado contra el banco y, si se
 * escribe, el monto que dice el estado de cuenta. Diferencia = banco − registrado.
 */

/** Sucursal del estado de cuenta: la pedida, o general si gerencia ve todas. */
function statementBranch(scope: Record<string, any>): Types.ObjectId | null {
  const b = scope.branch;
  return b && !b.$in ? (b as Types.ObjectId) : null;
}

export async function bankReconciliation(user: SessionUser, query: any) {
  const { from, to, start, end } = parseRange(query?.from, query?.to);
  const scope = branchFilter(user, query?.branch);
  const payments = await Payment.find({
    ...scope,
    status: "approved",
    method: { $in: ["transfer", "card"] },
    paidAt: { $gte: start, $lt: end },
  })
    .populate("customer", "name")
    .sort({ paidAt: 1 })
    .lean();
  const bookings = await Booking.find({ _id: { $in: payments.map((p) => p.booking) } })
    .select("paymentAccount")
    .lean();
  const bmap = new Map(bookings.map((b) => [String(b._id), b]));
  const [accountList, statements] = await Promise.all([
    listPaymentAccounts(),
    BankStatement.find({ branch: statementBranch(scope), from, to }).lean(),
  ]);

  const accounts = new Map<string, any>();
  const ensure = (account: string) => {
    if (!accounts.has(account))
      accounts.set(account, { account, registered: 0, verified: 0, count: 0, unverifiedCount: 0, payments: [] });
    return accounts.get(account);
  };
  // Las cuentas de transferencia configuradas aparecen aunque no tengan pagos (para cargar el banco).
  for (const a of accountList) if (a.method === "transfer") ensure(a.label);
  for (const p of payments) {
    const acc = ensure(accountLabel(p, bmap.get(String(p.booking)) as any));
    acc.registered += p.amount;
    acc.count++;
    if (p.verifiedAt) acc.verified += p.amount;
    else acc.unverifiedCount++;
    acc.payments.push({
      _id: p._id,
      booking: p.booking,
      bookingCode: p.bookingCode,
      customer: (p.customer as any)?.name ?? "",
      date: dateStrOf(new Date(p.paidAt!)),
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      proofUrl: p.proofUrl,
      verified: Boolean(p.verifiedAt),
      verifiedBy: p.verifiedBy?.name ?? "",
    });
  }
  const stmt = new Map(statements.map((s) => [s.account, s]));
  const items = [...accounts.values()]
    .map((a) => {
      const s = stmt.get(a.account);
      const bank = s ? s.amount : null;
      return {
        ...a,
        bank,
        bankNote: s?.note ?? "",
        bankFileUrl: s?.fileUrl ?? "",
        difference: bank === null ? null : bank - a.registered,
        pendingVerification: a.registered - a.verified,
      };
    })
    .sort((a, b) => (a.account === NO_ACCOUNT ? 1 : b.account === NO_ACCOUNT ? -1 : b.registered - a.registered));
  const sum = (k: string) => items.reduce((s, a) => s + (a[k] ?? 0), 0);
  return {
    from,
    to,
    items,
    totals: {
      registered: sum("registered"),
      verified: sum("verified"),
      pendingVerification: sum("pendingVerification"),
      unverifiedCount: sum("unverifiedCount"),
      count: sum("count"),
    },
  };
}

export async function verifyPayment(id: string, body: any, user: SessionUser) {
  assertObjectId(id, "el pago");
  const p = await Payment.findById(id);
  if (!p) throw new CustomError("Pago no encontrado", 404);
  branchFilter(user, String(p.branch));
  if (p.status !== "approved") throw new CustomError("Solo se verifican pagos aprobados", 409);
  const verified = Boolean(body?.verified);
  p.verifiedAt = verified ? new Date() : null;
  p.verifiedBy = verified ? (actor(user) ?? null) : null;
  await p.save();
  return { _id: p._id, verified, verifiedAt: p.verifiedAt, verifiedBy: p.verifiedBy?.name ?? "" };
}

/** Guarda (o borra con amount = null) lo que dice el banco para una cuenta y periodo. */
export async function saveStatement(body: any, user: SessionUser) {
  const account = str(body?.account, 80);
  if (!account) throw new CustomError("Indica la cuenta", 400);
  if (!isValidDate(body?.from) || !isValidDate(body?.to)) throw new CustomError("Periodo inválido", 400);
  const scope = branchFilter(user, body?.branch || undefined);
  const branch = statementBranch(scope);
  if (user.role !== "admin" && !branch) throw new CustomError("Elige una sucursal", 400);
  const key = { account, branch, from: body.from, to: body.to };
  if (body?.amount === null || body?.amount === "") {
    await BankStatement.deleteOne(key);
    return { ...key, amount: null };
  }
  const amount = cents(body.amount, "El monto del banco");
  const fileUrl = body?.fileUrl !== undefined ? str(body.fileUrl, 500) : undefined;
  if (fileUrl && !/^https:\/\/res\.cloudinary\.com\//.test(fileUrl)) throw new CustomError("Archivo del estado de cuenta inválido", 400);
  const doc = await BankStatement.findOneAndUpdate(
    key,
    { $set: { amount, note: str(body?.note, 200), updatedBy: actor(user), ...(fileUrl !== undefined ? { fileUrl } : {}) } },
    { upsert: true, new: true },
  ).lean();
  return doc;
}
