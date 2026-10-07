import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { PAYABLE_CATEGORIES, PAYABLE_METHODS, Payable } from "../models/payable.model";
import { SessionUser } from "../types/AuthRequest";
import { isValidDate, todayStr } from "../utils/date";
import { addMonths, fortnightBounds, monthParam } from "../utils/fortnight";
import { assertObjectId, cents, str } from "../utils/http";
import { actor, branchFilter } from "../utils/scope";

/**
 * Pagos por realizar (hoja "Pagos Quincenales"): Pagado = lo abonado; Pendiente = valor −
 * pagado; estado PENDIENTE / PARCIAL / PAGADO según esos montos.
 */

function statusOf(amount: number, paid: number): "pending" | "partial" | "paid" {
  if (paid <= 0) return amount === 0 ? "paid" : "pending";
  return paid >= amount ? "paid" : "partial";
}

function scopeOf(user: SessionUser, query: any) {
  if (query?.branch === "general") return { branch: null };
  return branchFilter(user, query?.branch);
}

export async function listPayables(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const filter: Record<string, any> = { month, ...scopeOf(user, query) };
  if (query?.fortnight === "1" || query?.fortnight === "2") filter.fortnight = Number(query.fortnight);
  if (["pending", "partial", "paid"].includes(String(query?.status))) filter.status = query.status;
  const items = await Payable.find(filter).sort({ fortnight: 1, dueDate: 1, createdAt: 1 }).lean();
  const total = items.reduce((s, p) => s + p.amount, 0);
  const paid = items.reduce((s, p) => s + Math.min(p.paidAmount, p.amount), 0);
  return {
    month,
    items,
    totals: {
      total,
      paid,
      pending: total - paid,
      paidRatio: total ? paid / total : 0,
      count: items.length,
      pendingCount: items.filter((p) => p.status !== "paid").length,
    },
  };
}

async function applyFields(target: any, body: any, user: SessionUser) {
  if (body?.month !== undefined) target.month = monthParam(body.month);
  if (body?.fortnight !== undefined) {
    const q = Number(body.fortnight);
    if (q !== 1 && q !== 2) throw new CustomError("La quincena debe ser 1 o 2", 400);
    target.fortnight = q;
  }
  if (body?.dueDate !== undefined) {
    if (body.dueDate && !isValidDate(body.dueDate)) throw new CustomError("Fecha prevista inválida", 400);
    target.dueDate = body.dueDate || "";
  }
  if (body?.beneficiary !== undefined) target.beneficiary = str(body.beneficiary, 160);
  if (body?.category !== undefined) {
    if (!(PAYABLE_CATEGORIES as readonly string[]).includes(String(body.category)))
      throw new CustomError("Categoría inválida", 400);
    target.category = body.category;
  }
  if (body?.amount !== undefined) target.amount = cents(body.amount, "El valor");
  if (body?.paidAmount !== undefined) target.paidAmount = cents(body.paidAmount, "Lo pagado");
  if (body?.paidDate !== undefined) {
    if (body.paidDate && !isValidDate(body.paidDate)) throw new CustomError("Fecha de pago inválida", 400);
    target.paidDate = body.paidDate || "";
  }
  if (body?.method !== undefined) {
    if (body.method && !(PAYABLE_METHODS as readonly string[]).includes(String(body.method)))
      throw new CustomError("Método de pago inválido", 400);
    target.method = body.method || "";
  }
  if (body?.account !== undefined) target.account = str(body.account, 80);
  if (body?.reference !== undefined) target.reference = str(body.reference, 120);
  if (body?.notes !== undefined) target.notes = str(body.notes, 300);
  if (body?.branch !== undefined) {
    if (!body.branch) {
      if (user.role !== "admin") throw new CustomError("Elige una sucursal", 400);
      target.branch = null;
    } else {
      const id = assertObjectId(body.branch, "la sucursal");
      branchFilter(user, id);
      if (!(await Branch.exists({ _id: id }))) throw new CustomError("Sucursal no encontrada", 404);
      target.branch = id;
    }
  }
  // "Marcar como pagado" manda solo status: se completa con el valor y la fecha de hoy.
  if (body?.status === "paid" && body?.paidAmount === undefined) target.paidAmount = target.amount;
  if (body?.status === "pending" && body?.paidAmount === undefined) target.paidAmount = 0;
  if (target.paidAmount > 0 && !target.paidDate) target.paidDate = todayStr();
  if (!target.paidAmount) target.paidDate = "";
  target.status = statusOf(target.amount ?? 0, target.paidAmount ?? 0);
}

export async function createPayable(body: any, user: SessionUser) {
  const data: any = { month: monthParam(body?.month), fortnight: 1, paidAmount: 0 };
  await applyFields(data, body, user);
  if (!data.beneficiary) throw new CustomError("Escribe el beneficiario o concepto", 400);
  if (data.amount === undefined) throw new CustomError("El valor es obligatorio", 400);
  data.status = statusOf(data.amount, data.paidAmount);
  data.createdBy = actor(user);
  return (await Payable.create(data)).toObject();
}

async function loadScoped(id: string, user: SessionUser) {
  assertObjectId(id, "el pago");
  const p = await Payable.findById(id);
  if (!p) throw new CustomError("Pago no encontrado", 404);
  if (p.branch) branchFilter(user, String(p.branch));
  else if (user.role !== "admin") throw new CustomError("No tienes acceso a este pago", 403);
  return p;
}

export async function updatePayable(id: string, body: any, user: SessionUser) {
  const p = await loadScoped(id, user);
  await applyFields(p, body, user);
  if (!p.beneficiary) throw new CustomError("Escribe el beneficiario o concepto", 400);
  await p.save();
  return p.toObject();
}

export async function deletePayable(id: string, user: SessionUser) {
  const p = await loadScoped(id, user);
  await p.deleteOne();
  return { ok: true };
}

/**
 * Copia la lista del mes anterior como pendiente (alquiler, créditos, servicios… se repiten
 * cada mes). No duplica: salta lo que ya existe con el mismo concepto, categoría y quincena.
 */
export async function copyPayables(body: any, user: SessionUser) {
  const month = monthParam(body?.month);
  const prev = addMonths(month, -1);
  const scope = scopeOf(user, body);
  const [sources, existing] = await Promise.all([
    Payable.find({ month: prev, ...scope }).lean(),
    Payable.find({ month, ...scope }).select("beneficiary category fortnight branch").lean(),
  ]);
  const key = (p: any) =>
    `${p.beneficiary.toLowerCase()}|${p.category}|${p.fortnight}|${String(p.branch ?? "")}`;
  const have = new Set(existing.map(key));
  const docs = sources
    .filter((p) => !have.has(key(p)))
    .map((p) => {
      const day = p.dueDate ? Number(p.dueDate.slice(8, 10)) : 0;
      const { from, to } = fortnightBounds(month, p.fortnight as 1 | 2);
      const dueDate = day ? `${month}-${String(day).padStart(2, "0")}` : "";
      return {
        branch: p.branch,
        month,
        fortnight: p.fortnight,
        dueDate: dueDate && dueDate >= from && dueDate <= to && isValidDate(dueDate) ? dueDate : "",
        beneficiary: p.beneficiary,
        category: p.category,
        amount: p.amount,
        paidAmount: 0,
        status: statusOf(p.amount, 0),
        account: p.account,
        notes: "",
        createdBy: actor(user),
      };
    });
  if (docs.length) await Payable.insertMany(docs);
  return { month, created: docs.length, skipped: sources.length - docs.length };
}
