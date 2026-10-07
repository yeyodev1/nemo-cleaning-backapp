import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Expense } from "../models/expense.model";
import { PayrollEntry } from "../models/payrollEntry.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { isValidDate, monthBounds } from "../utils/date";
import { fortnightOf, monthParam } from "../utils/fortnight";
import { assertObjectId, cents, str } from "../utils/http";
import { branchFilter } from "../utils/scope";

/**
 * Nómina quincenal (hojas "Nómina" + "Nómina Quincenal" del Excel):
 *   Q1 esperado = sueldo/2 − anticipos de la Q1;  Q2 esperado = sueldo − sueldo/2 − anticipos de la Q2
 *   (si los anticipos de la Q1 pasan la mitad, el resto se descuenta de la Q2).
 *   Estado = PENDIENTE sin pago, PARCIAL si pagó menos de lo esperado, PAGADO si cubre.
 *   Saldo pendiente = sueldo − anticipos − pagado Q1 − pagado Q2.
 * Los anticipos son gastos de categoría "anticipos" con el colaborador marcado.
 */

/** Campos de Personal que agrega la fase 2 (cargo y sueldo); tolera que aún no existan. */
function staffSalary(u: any): number {
  const n = Number(u?.monthlySalary ?? u?.salary ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const POSITION_LABEL: Record<string, string> = {
  supervisor: "Supervisor",
  assistant: "Asistente de base",
  base_assistant: "Asistente de base",
  washer: "Lavador",
};

function staffPosition(u: any): string {
  const raw = String(u?.position ?? u?.cargo ?? "").trim();
  if (raw) return POSITION_LABEL[raw] ?? raw;
  if (u?.role === "manager") return "Administrador";
  if (u?.role === "operator") return "Lavador";
  return "";
}

export type PayStatus = "pending" | "partial" | "paid";

function statusOf(paid: number, expected: number): PayStatus {
  if (expected <= 0) return paid > 0 || expected === 0 ? "paid" : "pending";
  if (!paid) return "pending";
  return paid < expected ? "partial" : "paid";
}

function staffFilter(scope: Record<string, any>) {
  const userFilter: Record<string, any> = { active: true };
  if (scope.branch) userFilter.branches = scope.branch.$in ? { $in: scope.branch.$in } : scope.branch;
  return userFilter;
}

/**
 * La primera vez que se abre un mes se crean sus filas con el personal activo que tiene
 * sueldo. Solo esa vez: si alguien se quita del mes no vuelve a aparecer solo (los nuevos
 * se agregan con "Agregar colaborador", que los sugiere en `missing`).
 */
async function ensureMonth(month: string, scope: Record<string, any>) {
  if (await PayrollEntry.exists({ month, ...scope })) return;
  const staff = await User.find(staffFilter(scope)).lean();
  const ops = staff
    .filter((u) => staffSalary(u) > 0)
    .map((u) => ({
      updateOne: {
        filter: { month, user: u._id },
        update: {
          $setOnInsert: {
            month,
            user: u._id,
            name: u.name,
            position: staffPosition(u),
            branch: u.branches?.[0] ?? null,
            salary: staffSalary(u),
          },
        },
        upsert: true,
      },
    }));
  if (ops.length) await PayrollEntry.bulkWrite(ops, { ordered: false });
}

/** Anticipos del mes por colaborador y quincena (centavos). */
async function advancesByUser(month: string, userIds: Types.ObjectId[]) {
  const { from, to } = monthBounds(month);
  const rows = await Expense.find({
    category: "anticipos",
    employee: { $in: userIds },
    date: { $gte: from, $lte: to },
  })
    .select("employee date amount")
    .lean();
  const out = new Map<string, { q1: number; q2: number }>();
  for (const r of rows) {
    const key = String(r.employee);
    const acc = out.get(key) ?? { q1: 0, q2: 0 };
    if (fortnightOf(r.date) === 1) acc.q1 += r.amount;
    else acc.q2 += r.amount;
    out.set(key, acc);
  }
  return out;
}

export function computeRow(e: any, adv: { q1: number; q2: number }) {
  const half = Math.round(e.salary / 2);
  const carry = Math.max(0, adv.q1 - half);
  const q1Expected = Math.max(0, half - adv.q1);
  const q2Expected = Math.max(0, e.salary - half - adv.q2 - carry);
  const q1Paid = e.q1?.paid ?? 0;
  const q2Paid = e.q2?.paid ?? 0;
  const advances = adv.q1 + adv.q2;
  const totalPaid = q1Paid + q2Paid;
  return {
    _id: e._id,
    month: e.month,
    user: e.user,
    name: e.name,
    position: e.position,
    branch: e.branch,
    salary: e.salary,
    advances,
    q1: { ...e.q1, expected: q1Expected, advances: adv.q1, status: statusOf(q1Paid, q1Expected) },
    q2: { ...e.q2, expected: q2Expected, advances: adv.q2, status: statusOf(q2Paid, q2Expected) },
    totalPaid,
    pending: Math.max(0, e.salary - advances - totalPaid),
    notes: e.notes ?? "",
  };
}

/** Filas calculadas del mes (sin crear nada): las usa también el reporte quincenal. */
export async function payrollRows(month: string, scope: Record<string, any>) {
  const entries = await PayrollEntry.find({ month, ...scope }).sort({ name: 1 }).lean();
  const adv = await advancesByUser(
    month,
    entries.map((e) => e.user as Types.ObjectId),
  );
  return entries.map((e) => computeRow(e, adv.get(String(e.user)) ?? { q1: 0, q2: 0 }));
}

export async function listPayroll(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const scope = branchFilter(user, query?.branch);
  await ensureMonth(month, scope);
  const items = await payrollRows(month, scope);
  const sum = (fn: (r: (typeof items)[number]) => number) => items.reduce((s, r) => s + fn(r), 0);
  const totalSalary = sum((r) => r.salary);
  const paidQ1 = sum((r) => r.q1.paid ?? 0);
  const paidQ2 = sum((r) => r.q2.paid ?? 0);
  const advances = sum((r) => r.advances);
  const inMonth = new Set(items.map((r) => String(r.user)));
  const missing = (await User.find(staffFilter(scope)).select("name").sort({ name: 1 }).lean())
    .filter((u) => !inMonth.has(String(u._id)))
    .map((u) => ({ _id: u._id, name: u.name, salary: staffSalary(u), position: staffPosition(u) }));
  return {
    month,
    items,
    missing,
    totals: {
      salary: totalSalary,
      advances,
      paidQ1,
      paidQ2,
      paid: paidQ1 + paidQ2,
      pending: sum((r) => r.pending),
      // % pagado cuenta los anticipos: ya son sueldo entregado.
      paidRatio: totalSalary ? (paidQ1 + paidQ2 + advances) / totalSalary : 0,
    },
  };
}

function applyPay(target: any, raw: any) {
  if (!raw || typeof raw !== "object") return;
  if (raw.paid !== undefined) target.paid = cents(raw.paid, "Lo pagado");
  if (raw.date !== undefined) {
    if (raw.date && !isValidDate(raw.date)) throw new CustomError("Fecha de pago inválida", 400);
    target.date = raw.date || "";
  }
  if (raw.method !== undefined) target.method = str(raw.method, 40);
  if (raw.reference !== undefined) target.reference = str(raw.reference, 120);
}

async function loadEntry(id: string, user: SessionUser) {
  assertObjectId(id, "la fila de nómina");
  const entry = await PayrollEntry.findById(id);
  if (!entry) throw new CustomError("Fila de nómina no encontrada", 404);
  if (entry.branch) branchFilter(user, String(entry.branch));
  return entry;
}

async function rowOf(entry: any) {
  const adv = await advancesByUser(entry.month, [entry.user]);
  return computeRow(entry.toObject(), adv.get(String(entry.user)) ?? { q1: 0, q2: 0 });
}

export async function updatePayroll(id: string, body: any, user: SessionUser) {
  const entry = await loadEntry(id, user);
  if (body?.salary !== undefined) entry.salary = cents(body.salary, "El sueldo");
  if (body?.position !== undefined) entry.position = str(body.position, 60);
  if (body?.notes !== undefined) entry.notes = str(body.notes, 300);
  applyPay(entry.q1, body?.q1);
  applyPay(entry.q2, body?.q2);
  entry.markModified("q1");
  entry.markModified("q2");
  await entry.save();
  return rowOf(entry);
}

/** Agrega a alguien del Personal que no tenía sueldo cargado (o un pago puntual del mes). */
export async function addPayroll(body: any, user: SessionUser) {
  const month = monthParam(body?.month);
  const userId = assertObjectId(body?.user, "el colaborador");
  const staff = await User.findById(userId).lean();
  if (!staff) throw new CustomError("Colaborador no encontrado", 404);
  if (await PayrollEntry.exists({ month, user: userId }))
    throw new CustomError(`${staff.name} ya está en la nómina de este mes`, 409);
  const branch = staff.branches?.[0] ?? null;
  if (branch) branchFilter(user, String(branch));
  const entry = await PayrollEntry.create({
    month,
    user: userId,
    name: staff.name,
    position: staffPosition(staff),
    branch,
    salary: body?.salary !== undefined ? cents(body.salary, "El sueldo") : staffSalary(staff),
  });
  return rowOf(entry);
}

export async function deletePayroll(id: string, user: SessionUser) {
  const entry = await loadEntry(id, user);
  await entry.deleteOne();
  return { ok: true };
}
