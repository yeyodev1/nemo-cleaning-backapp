import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { Branch } from "../models/branch.model";
import { CASH_CONCEPTS, CashMovement } from "../models/cashMovement.model";
import { Expense } from "../models/expense.model";
import { Payment } from "../models/payment.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { dateStrOf, dayRange, isValidDate, parseRange, todayStr } from "../utils/date";
import { assertObjectId, cents, str } from "../utils/http";
import { actor, branchFilter } from "../utils/scope";

/**
 * Registro de caja (hoja "Registro de caja"): saldo inicial + ingresos − egresos = saldo,
 * fila por fila. Entran solos los cobros en EFECTIVO (por la fecha del pago) y salen solos
 * los gastos de CAJA MENOR pagados en efectivo; el resto son movimientos manuales
 * (propina en efectivo, entrega a gerencia, reposición, ajuste). El saldo inicial del
 * periodo es todo lo acumulado antes del primer día.
 */

const PETTY_CASH = { paidFrom: "petty_cash", paymentMethod: "cash" };

async function sumBefore(scope: Record<string, any>, from: string) {
  const start = dayRange(from).start;
  const [pay, exp, mov] = await Promise.all([
    Payment.aggregate<{ total: number }>([
      { $match: { ...scope, status: "approved", method: "cash", paidAt: { $lt: start } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Expense.aggregate<{ total: number }>([
      { $match: { ...scope, ...PETTY_CASH, date: { $lt: from } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    CashMovement.aggregate<{ _id: string; total: number }>([
      { $match: { ...scope, date: { $lt: from } } },
      { $group: { _id: "$direction", total: { $sum: "$amount" } } },
    ]),
  ]);
  const movIn = mov.find((m) => m._id === "in")?.total ?? 0;
  const movOut = mov.find((m) => m._id === "out")?.total ?? 0;
  return (pay[0]?.total ?? 0) - (exp[0]?.total ?? 0) + movIn - movOut;
}

interface Row {
  key: string;
  source: "payment" | "expense" | "manual";
  id: string;
  date: string;
  at: number;
  concept: string;
  operator: string;
  detail: string;
  in: number;
  out: number;
  balance: number;
  branch: string;
}

export async function cashRegister(user: SessionUser, query: any) {
  const { from, to, start, end } = parseRange(query?.from ?? todayStr(), query?.to ?? query?.from ?? todayStr());
  const scope = branchFilter(user, query?.branch);
  const [opening, payments, expenses, manual] = await Promise.all([
    sumBefore(scope, from),
    Payment.find({ ...scope, status: "approved", method: "cash", paidAt: { $gte: start, $lt: end } })
      .populate("customer", "name")
      .lean(),
    Expense.find({ ...scope, ...PETTY_CASH, date: { $gte: from, $lte: to } }).lean(),
    CashMovement.find({ ...scope, date: { $gte: from, $lte: to } })
      .populate("operator", "name")
      .lean(),
  ]);
  const bookings = await Booking.find({ _id: { $in: payments.map((p) => p.booking) } })
    .select("operators")
    .populate("operators", "name")
    .lean();
  const ops = new Map(
    bookings.map((b) => [String(b._id), (b.operators as any[]).map((o) => o?.name).filter(Boolean).join(", ")]),
  );

  const rows: Row[] = [
    ...payments.map((p) => ({
      key: `p${p._id}`,
      source: "payment" as const,
      id: String(p.booking),
      date: dateStrOf(new Date(p.paidAt!)),
      at: new Date(p.paidAt!).getTime(),
      concept: "production",
      operator: ops.get(String(p.booking)) ?? "",
      detail: `${(p.customer as any)?.name || "Cliente"} · ${p.bookingCode}`,
      in: p.amount,
      out: 0,
      balance: 0,
      branch: String(p.branch),
    })),
    ...expenses.map((e) => ({
      key: `e${e._id}`,
      source: "expense" as const,
      id: String(e._id),
      date: e.date,
      at: new Date(e.createdAt).getTime(),
      concept: e.category,
      operator: "",
      detail: e.description,
      in: 0,
      out: e.amount,
      balance: 0,
      branch: String(e.branch ?? ""),
    })),
    ...manual.map((m) => ({
      key: `m${m._id}`,
      source: "manual" as const,
      id: String(m._id),
      date: m.date,
      at: new Date(m.createdAt).getTime(),
      concept: m.concept,
      operator: (m.operator as any)?.name ?? "",
      detail: m.detail,
      in: m.direction === "in" ? m.amount : 0,
      out: m.direction === "out" ? m.amount : 0,
      balance: 0,
      branch: String(m.branch),
    })),
  ].sort((a, b) => (a.date === b.date ? a.at - b.at : a.date < b.date ? -1 : 1));

  let running = opening;
  for (const r of rows) {
    running += r.in - r.out;
    r.balance = running;
  }
  const totalIn = rows.reduce((s, r) => s + r.in, 0);
  const totalOut = rows.reduce((s, r) => s + r.out, 0);
  return {
    from,
    to,
    opening,
    totalIn,
    totalOut,
    closing: opening + totalIn - totalOut,
    production: rows.filter((r) => r.source === "payment").reduce((s, r) => s + r.in, 0),
    pettyCash: rows.filter((r) => r.source === "expense").reduce((s, r) => s + r.out, 0),
    rows: rows.map(({ at, ...r }) => r),
  };
}

async function applyFields(target: any, body: any, user: SessionUser) {
  if (body?.date !== undefined) {
    if (!isValidDate(body.date)) throw new CustomError("Fecha inválida (YYYY-MM-DD)", 400);
    target.date = body.date;
  }
  if (body?.direction !== undefined) {
    if (!["in", "out"].includes(body.direction)) throw new CustomError("Indica si es ingreso o egreso", 400);
    target.direction = body.direction;
  }
  if (body?.concept !== undefined) {
    if (!(CASH_CONCEPTS as readonly string[]).includes(String(body.concept)))
      throw new CustomError("Concepto inválido", 400);
    target.concept = body.concept;
  }
  if (body?.amount !== undefined) target.amount = cents(body.amount, "El monto", { allowZero: false });
  if (body?.detail !== undefined) target.detail = str(body.detail, 300);
  if (body?.operator !== undefined) {
    if (!body.operator) target.operator = null;
    else {
      const id = assertObjectId(body.operator, "el operador");
      if (!(await User.exists({ _id: id }))) throw new CustomError("Operador no encontrado", 404);
      target.operator = id;
    }
  }
  if (body?.branch !== undefined) {
    const id = assertObjectId(body.branch, "la sucursal");
    branchFilter(user, id);
    if (!(await Branch.exists({ _id: id }))) throw new CustomError("Sucursal no encontrada", 404);
    target.branch = id;
  }
}

export async function createMovement(body: any, user: SessionUser) {
  const data: any = { date: todayStr() };
  await applyFields(data, body, user);
  if (!data.branch) throw new CustomError("Elige la sucursal de la caja", 400);
  if (!data.direction) throw new CustomError("Indica si es ingreso o egreso", 400);
  if (data.amount === undefined) throw new CustomError("El monto es obligatorio", 400);
  data.createdBy = actor(user);
  return (await CashMovement.create(data)).toObject();
}

async function loadScoped(id: string, user: SessionUser) {
  assertObjectId(id, "el movimiento");
  const m = await CashMovement.findById(id);
  if (!m) throw new CustomError("Movimiento no encontrado", 404);
  branchFilter(user, String(m.branch));
  return m;
}

export async function updateMovement(id: string, body: any, user: SessionUser) {
  const m = await loadScoped(id, user);
  await applyFields(m, body, user);
  await m.save();
  return m.toObject();
}

export async function deleteMovement(id: string, user: SessionUser) {
  const m = await loadScoped(id, user);
  await m.deleteOne();
  return { ok: true };
}
