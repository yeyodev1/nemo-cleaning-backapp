import { CustomError } from "../errors/customError.error";
import { Types } from "mongoose";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_KINDS,
  Expense,
  FIXED_BY_DEFAULT,
  PAID_FROM,
} from "../models/expense.model";
import { Branch } from "../models/branch.model";
import { User } from "../models/user.model";
import { addMonths, monthParam, sameDayIn } from "../utils/fortnight";
import { monthBounds } from "../utils/date";
import { SessionUser } from "../types/AuthRequest";
import { isValidDate, todayStr } from "../utils/date";
import { assertObjectId, cents, paginated, parsePage, str } from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";

const METHODS = ["cash", "transfer", "card"];

/** El manager solo maneja caja menor de sus sucursales; gerencia, todo. */
function scopeFilter(user: SessionUser, query: any): Record<string, any> {
  if (user.role === "admin") {
    if (query?.branch === "general") return { branch: null };
    return branchFilter(user, query?.branch);
  }
  return { ...branchFilter(user, query?.branch), paidFrom: "petty_cash" };
}

export async function listExpenses(user: SessionUser, query: any) {
  const { page, limit, skip } = parsePage(query);
  const filter = scopeFilter(user, query);
  if (query?.category) filter.category = { $in: String(query.category).split(",") };
  if ((EXPENSE_KINDS as readonly string[]).includes(String(query?.kind))) filter.kind = query.kind;
  if (query?.paidFrom && (PAID_FROM as readonly string[]).includes(String(query.paidFrom))) {
    if (user.role === "manager" && query.paidFrom !== "petty_cash")
      throw new CustomError("No tienes acceso a los gastos de gerencia", 403);
    filter.paidFrom = String(query.paidFrom);
  }
  if (isValidDate(query?.from) || isValidDate(query?.to)) {
    filter.date = {};
    if (isValidDate(query.from)) filter.date.$gte = query.from;
    if (isValidDate(query.to)) filter.date.$lte = query.to;
  }
  const [items, total, sum] = await Promise.all([
    Expense.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Expense.countDocuments(filter),
    Expense.aggregate<{ _id: { kind: string; paidFrom: string }; total: number }>([
      { $match: filter },
      { $group: { _id: { kind: "$kind", paidFrom: "$paidFrom" }, total: { $sum: "$amount" } } },
    ]),
  ]);
  // Totales del filtro completo (no solo la página) para las tarjetas de arriba.
  const by = (fn: (k: { kind: string; paidFrom: string }) => boolean) =>
    sum.filter((r) => fn(r._id)).reduce((s, r) => s + r.total, 0);
  return {
    ...paginated(items, total, page, limit),
    totalAmount: by(() => true),
    totals: {
      fixed: by((k) => k.kind === "fixed"),
      variable: by((k) => k.kind !== "fixed"),
      pettyCash: by((k) => k.paidFrom === "petty_cash"),
      management: by((k) => k.paidFrom === "management"),
    },
  };
}

async function applyFields(target: any, body: any, user: SessionUser) {
  if (body?.date !== undefined) {
    if (!isValidDate(body.date)) throw new CustomError("Fecha inválida (YYYY-MM-DD)", 400);
    target.date = body.date;
  }
  if (body?.category !== undefined) {
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(String(body.category)))
      throw new CustomError("Categoría inválida", 400);
    target.category = String(body.category);
  }
  if (body?.description !== undefined) target.description = str(body.description, 300);
  if (body?.amount !== undefined)
    target.amount = cents(body.amount, "El monto", { allowZero: false });
  if (body?.paymentMethod !== undefined) {
    if (!METHODS.includes(String(body.paymentMethod)))
      throw new CustomError("Método de pago inválido", 400);
    target.paymentMethod = String(body.paymentMethod);
  }
  if (body?.paidFrom !== undefined) {
    if (!(PAID_FROM as readonly string[]).includes(String(body.paidFrom)))
      throw new CustomError("Origen del gasto inválido", 400);
    target.paidFrom = String(body.paidFrom);
  }
  if (body?.kind !== undefined) {
    if (!(EXPENSE_KINDS as readonly string[]).includes(String(body.kind)))
      throw new CustomError("Tipo de gasto inválido (fijo o variable)", 400);
    target.kind = String(body.kind);
  } else if (body?.category !== undefined && !target.kind) {
    target.kind = FIXED_BY_DEFAULT.includes(String(body.category)) ? "fixed" : "variable";
  }
  if (body?.recurring !== undefined) target.recurring = Boolean(body.recurring);
  if (body?.employee !== undefined) {
    if (!body.employee) target.employee = null;
    else {
      const id = assertObjectId(body.employee, "el colaborador");
      if (!(await User.exists({ _id: id }))) throw new CustomError("Colaborador no encontrado", 404);
      target.employee = id;
    }
  }
  if (body?.supplier !== undefined) target.supplier = str(body.supplier, 160);
  if (body?.receiptUrl !== undefined) target.receiptUrl = str(body.receiptUrl, 500);
  if (body?.branch !== undefined) {
    if (body.branch === null || body.branch === "") target.branch = null;
    else {
      const id = assertObjectId(body.branch, "la sucursal");
      if (!(await Branch.exists({ _id: id }))) throw new CustomError("Sucursal no encontrada", 404);
      target.branch = id;
    }
  }
  if (user.role === "manager") {
    if (target.paidFrom && target.paidFrom !== "petty_cash")
      throw new CustomError("Solo puedes registrar gastos de caja menor", 403);
    target.paidFrom = "petty_cash";
    assertBranchAccess(user, target.branch);
  }
}

export async function createExpense(body: any, user: SessionUser) {
  const data: any = {
    date: todayStr(),
    paidFrom: user.role === "manager" ? "petty_cash" : "management",
  };
  await applyFields(data, body, user);
  if (!data.description) throw new CustomError("Describe el gasto", 400);
  if (data.amount === undefined) throw new CustomError("El monto es obligatorio", 400);
  data.createdBy = actor(user);
  if (body?.installments) return createInstallments(data, body.installments);
  const created = await Expense.create(data);
  // Un gasto recurrente es la cabeza de su serie: las copias de cada mes llevan su id.
  if (created.recurring && !created.seriesKey) {
    created.seriesKey = String(created._id);
    await created.save();
  }
  return created.toObject();
}

/**
 * Diferido: el monto es el TOTAL y se reparte en N cuotas mensuales desde la fecha dada
 * (la última absorbe los centavos que sobran). `first` permite cargar un diferido que ya
 * venía pagándose ("Diferido moto 10/12" → first = 10).
 */
async function createInstallments(data: any, raw: any) {
  const count = Number(raw?.count);
  const first = raw?.first === undefined ? 1 : Number(raw.first);
  if (!Number.isInteger(count) || count < 2 || count > 60)
    throw new CustomError("El número de cuotas debe estar entre 2 y 60", 400);
  if (!Number.isInteger(first) || first < 1 || first > count)
    throw new CustomError(`La cuota inicial debe estar entre 1 y ${count}`, 400);
  const total = data.amount as number;
  const base = Math.floor(total / count);
  const seriesKey = new Types.ObjectId().toString();
  const label = /^diferido/i.test(data.description) ? data.description : `Diferido ${data.description}`;
  const day = Number(String(data.date).slice(8, 10));
  const startMonth = String(data.date).slice(0, 7);
  const docs = [];
  for (let n = first; n <= count; n++) {
    const amount = n === count ? total - base * (count - 1) : base;
    docs.push({
      ...data,
      description: `${label} ${n}/${count}`,
      amount,
      date: sameDayIn(addMonths(startMonth, n - first), day),
      recurring: false,
      seriesKey,
      installment: { number: n, count, totalAmount: total },
    });
  }
  const created = await Expense.insertMany(docs);
  return { ...created[0].toObject(), createdCount: created.length };
}

/**
 * "Repetir gastos fijos": copia al mes pedido los gastos recurrentes del mes anterior que
 * aún no tengan copia (misma serie). Idempotente: dos clics no duplican el alquiler.
 */
export async function repeatFixed(user: SessionUser, body: any) {
  const month = monthParam(body?.month);
  const prev = monthBounds(addMonths(month, -1));
  const target = monthBounds(month);
  const filter: Record<string, any> = {
    ...scopeFilter(user, body),
    recurring: true,
    date: { $gte: prev.from, $lte: prev.to },
  };
  const sources = await Expense.find(filter).lean();
  let created = 0;
  let skipped = 0;
  const names: string[] = [];
  for (const src of sources) {
    const seriesKey = src.seriesKey || String(src._id);
    if (!src.seriesKey) await Expense.updateOne({ _id: src._id }, { $set: { seriesKey } });
    const exists = await Expense.exists({
      seriesKey,
      date: { $gte: target.from, $lte: target.to },
    });
    if (exists) {
      skipped++;
      continue;
    }
    const { _id, createdAt, updatedAt, ...rest } = src as any;
    await Expense.create({
      ...rest,
      seriesKey,
      date: sameDayIn(month, Number(src.date.slice(8, 10))),
      receiptUrl: "",
      createdBy: actor(user),
    });
    created++;
    names.push(src.description);
  }
  return { month, created, skipped, names };
}

async function loadScoped(id: string, user: SessionUser) {
  assertObjectId(id, "el gasto");
  const expense = await Expense.findById(id);
  if (!expense) throw new CustomError("Gasto no encontrado", 404);
  if (user.role === "manager") {
    if (expense.paidFrom !== "petty_cash")
      throw new CustomError("No tienes acceso a este gasto", 403);
    assertBranchAccess(user, expense.branch);
  }
  return expense;
}

export async function updateExpense(id: string, body: any, user: SessionUser) {
  const expense = await loadScoped(id, user);
  await applyFields(expense, body, user);
  if (!expense.description) throw new CustomError("Describe el gasto", 400);
  await expense.save();
  return expense.toObject();
}

/** `scope = "series"` borra todas las cuotas de un diferido (no aplica a los recurrentes). */
export async function deleteExpense(id: string, user: SessionUser, scope?: unknown) {
  const expense = await loadScoped(id, user);
  if (scope === "series" && expense.installment && expense.seriesKey) {
    const r = await Expense.deleteMany({ seriesKey: expense.seriesKey, installment: { $ne: null } });
    return { ok: true, deleted: r.deletedCount };
  }
  await expense.deleteOne();
  return { ok: true, deleted: 1 };
}
