import { CustomError } from "../errors/customError.error";
import { EXPENSE_CATEGORIES, Expense, PAID_FROM } from "../models/expense.model";
import { Branch } from "../models/branch.model";
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
    Expense.aggregate<{ total: number }>([
      { $match: filter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);
  return { ...paginated(items, total, page, limit), totalAmount: sum[0]?.total ?? 0 };
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
  return (await Expense.create(data)).toObject();
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

export async function deleteExpense(id: string, user: SessionUser) {
  const expense = await loadScoped(id, user);
  await expense.deleteOne();
  return { ok: true };
}
