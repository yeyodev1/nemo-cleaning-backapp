import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Expense } from "../models/expense.model";
import { PayrollEntry } from "../models/payrollEntry.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { isValidDate, monthBounds } from "../utils/date";
import { fortnightOf, monthParam, yearParam } from "../utils/fortnight";
import { assertObjectId, cents, str } from "../utils/http";
import { branchFilter } from "../utils/scope";
import { branchNames, staffOptions } from "./commissionEntry.service";

/**
 * Nómina quincenal (hojas "Nómina" + "Nómina Quincenal" del Excel):
 *   Q1 esperado = sueldo/2 − anticipos de la Q1;  Q2 esperado = sueldo − sueldo/2 − anticipos de la Q2
 *   (si los anticipos de la Q1 pasan la mitad, el resto se descuenta de la Q2).
 *   Estado = PENDIENTE sin pago, PARCIAL si pagó menos de lo esperado, PAGADO si cubre.
 *   Saldo pendiente = sueldo − anticipos − pagado Q1 − pagado Q2.
 * Los anticipos son gastos de categoría "anticipos" con el colaborador marcado.
 */

/** Campos de Personal que agrega la fase 2 (cargo y sueldo); tolera que aún no existan. */
export function staffSalary(u: any): number {
  const n = Number(u?.monthlySalary ?? u?.salary ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const POSITION_LABEL: Record<string, string> = {
  supervisor: "Supervisor",
  assistant: "Asistente de base",
  base_assistant: "Asistente de base",
  washer: "Lavador",
};

export function staffPosition(u: any): string {
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

// ---------------------------------------------------------------------------
// Grilla anual (hoja "Nómina" del Excel): sueldo base por colaborador y mes.
// Cada celda es la `PayrollEntry` de ese mes: editar un mes no toca los demás.
// ---------------------------------------------------------------------------

const yearMonths = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
const hasPayments = (e: any) => (e.q1?.paid ?? 0) > 0 || (e.q2?.paid ?? 0) > 0;

/** GET /admin/finance/payroll/year?year=&branch= */
export async function payrollYear(user: SessionUser, query: any) {
  const year = yearParam(query?.year);
  const scope = branchFilter(user, query?.branch);
  const months = yearMonths(year);
  const [entries, names, staff] = await Promise.all([
    PayrollEntry.find({ ...scope, month: { $gte: months[0], $lte: months[11] } }).sort({ month: 1 }).lean(),
    branchNames(),
    staffOptions(scope),
  ]);
  const people = await User.find({ _id: { $in: [...new Set(entries.map((e) => String(e.user)))] } })
    .select("name active")
    .lean();
  const personMap = new Map(people.map((p) => [String(p._id), p]));
  const rows = new Map<string, any>();
  for (const e of entries) {
    const key = String(e.user);
    const person = personMap.get(key);
    const row =
      rows.get(key) ??
      {
        key,
        user: key,
        name: person?.name ?? e.name,
        active: person?.active !== false,
        branch: e.branch ? String(e.branch) : null,
        branchName: e.branch ? (names.get(String(e.branch)) ?? "") : "",
        position: "",
        months: Array<number | null>(12).fill(null),
        locked: Array<boolean>(12).fill(false),
        notes: Array<string>(12).fill(""),
        total: 0,
      };
    const i = Number(e.month.slice(5, 7)) - 1;
    row.months[i] = e.salary;
    row.locked[i] = hasPayments(e);
    row.notes[i] = e.notes ?? "";
    // El cargo que se muestra es el del último mes cargado (como "Cargo / detalle" del Excel).
    row.position = e.position || row.position;
    row.total += e.salary;
    rows.set(key, row);
  }
  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const monthTotals = Array.from({ length: 12 }, (_, i) => list.reduce((s, r) => s + (r.months[i] ?? 0), 0));
  return { year, rows: list, monthTotals, total: monthTotals.reduce((s, n) => s + n, 0), staff };
}

/**
 * PUT /admin/finance/payroll/salary — `{ user, month, salary (centavos) | null, position?, branch? }`.
 * Crea la fila del mes si no existe (`position`/`branch` solo se usan al crearla); `salary` null la quita (si no tiene pagos de quincena).
 */
export async function saveSalary(user: SessionUser, body: any) {
  const month = monthParam(body?.month);
  const userId = assertObjectId(String(body?.user ?? ""), "el colaborador");
  const entry = await PayrollEntry.findOne({ month, user: userId });
  if (entry?.branch) branchFilter(user, String(entry.branch));
  const empty = body?.salary === null || body?.salary === undefined || body?.salary === "";
  if (empty) {
    if (!entry) return { ok: true, salary: null };
    if (hasPayments(entry))
      throw new CustomError("Ese mes ya tiene pagos de quincena registrados: pon 0 o borra primero los pagos", 409);
    await entry.deleteOne();
    return { ok: true, salary: null };
  }
  const salary = cents(body.salary, "El sueldo");
  if (entry) {
    // Solo el sueldo: el cargo de cada mes se queda como estaba ("Lavador - solo hasta JUL").
    entry.salary = salary;
    await entry.save();
    return { ok: true, salary };
  }
  const staff = await User.findById(userId).lean();
  if (!staff) throw new CustomError("Colaborador no encontrado", 404);
  const branch = body?.branch ? assertObjectId(String(body.branch), "la sucursal") : staff.branches?.[0] ?? null;
  if (branch) branchFilter(user, String(branch));
  await PayrollEntry.create({
    month,
    user: userId,
    name: staff.name,
    position: body?.position !== undefined ? str(body.position, 80) : staffPosition(staff),
    branch,
    salary,
  });
  return { ok: true, salary };
}

/** POST /admin/finance/payroll/copy — `{ from, to, branch? }`: repite los sueldos sin pisar lo ya escrito. */
export async function copyPayroll(user: SessionUser, body: any) {
  const from = monthParam(body?.from);
  const to = monthParam(body?.to);
  if (from === to) throw new CustomError("Elige meses distintos", 400);
  const scope = branchFilter(user, body?.branch);
  const source = await PayrollEntry.find({ month: from, ...scope }).lean();
  if (!source.length) throw new CustomError("Ese mes no tiene sueldos para copiar", 404);
  const r = await PayrollEntry.bulkWrite(
    source.map((e) => ({
      updateOne: {
        filter: { month: to, user: e.user },
        update: {
          $setOnInsert: { month: to, user: e.user, name: e.name, position: e.position, branch: e.branch, salary: e.salary },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return { ok: true, copied: r.upsertedCount, skipped: source.length - r.upsertedCount };
}

/** POST /admin/finance/payroll/remove-row — `{ user, year }`: quita al colaborador del año (sin tocar meses con pagos). */
export async function removePayrollRow(user: SessionUser, body: any) {
  const year = yearParam(body?.year);
  const userId = assertObjectId(String(body?.user ?? ""), "el colaborador");
  const months = yearMonths(year);
  const entries = await PayrollEntry.find({ user: userId, month: { $gte: months[0], $lte: months[11] } });
  let deleted = 0;
  let kept = 0;
  for (const e of entries) {
    if (e.branch) branchFilter(user, String(e.branch));
    if (hasPayments(e)) kept++;
    else {
      await e.deleteOne();
      deleted++;
    }
  }
  return { ok: true, deleted, kept };
}
