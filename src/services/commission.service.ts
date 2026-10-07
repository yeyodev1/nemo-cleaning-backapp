import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import {
  CommissionAdjustment,
  CommissionRule,
  DEFAULT_TIERS,
  ICommissionTier,
} from "../models/commission.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { currentMonth, daysBetween, isValidDate, isValidMonth, monthBounds } from "../utils/date";
import { assertObjectId, str } from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";

/**
 * Comisiones diarias (FEE) como en las hojas "FEE <MES>" del Excel:
 *   EXCEDENTE = producción del operador en el día − base diaria ($60)
 *   FEE = excedente × % del tramo (solo si el excedente es > 0)
 *   FEE SUPERVISOR = excedente × % supervisor (14 %), para quien supervisa al operador.
 * La producción se calcula con todas las sucursales del día (la base es diaria) y luego
 * se reparte a cada sucursal según lo que el operador produjo en ella.
 */

/** Quincena del Excel: Q1 = días 1–15, Q2 = 16–fin de mes. */
const fortnightOf = (date: string) => (Number(date.slice(8, 10)) <= 15 ? 1 : 2);

function monthParam(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return currentMonth();
  if (!isValidMonth(raw)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  return raw;
}

type Rule = {
  dailyBase: number;
  tiers: ICommissionTier[];
  supervisorPercent: number;
  exceptions: { operator: string; tiers: ICommissionTier[]; note: string }[];
};

export async function getRule(): Promise<Rule> {
  const doc = await CommissionRule.findOneAndUpdate(
    { key: "main" },
    { $setOnInsert: { key: "main" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return {
    dailyBase: doc!.dailyBase ?? 6000,
    tiers: sortTiers(doc!.tiers?.length ? doc!.tiers : DEFAULT_TIERS),
    supervisorPercent: doc!.supervisorPercent ?? 14,
    exceptions: (doc!.exceptions ?? []).map((e) => ({
      operator: String(e.operator),
      tiers: sortTiers(e.tiers ?? []),
      note: e.note ?? "",
    })),
  };
}

function sortTiers(tiers: ICommissionTier[]): ICommissionTier[] {
  return [...tiers]
    .map((t) => ({ above: t.above, percent: t.percent }))
    .sort((a, b) => a.above - b.above);
}

/** % del tramo de mayor `above` que el excedente supera (el primero aplica desde 0). */
export function percentFor(excess: number, tiers: ICommissionTier[]): number {
  if (excess <= 0 || !tiers.length) return 0;
  let pct = tiers[0].percent;
  for (const t of tiers) if (excess > t.above || t.above === 0) pct = t.percent;
  return pct;
}

function parseTiers(raw: unknown, label: string): ICommissionTier[] {
  if (!Array.isArray(raw) || !raw.length) throw new CustomError(`${label}: agrega al menos un tramo`, 400);
  const tiers = raw.map((t: any) => ({ above: Number(t?.above), percent: Number(t?.percent) }));
  for (const t of tiers) {
    if (!Number.isInteger(t.above) || t.above < 0)
      throw new CustomError(`${label}: el excedente debe ser un valor en centavos ≥ 0`, 400);
    if (!Number.isFinite(t.percent) || t.percent < 0 || t.percent > 100)
      throw new CustomError(`${label}: el porcentaje debe estar entre 0 y 100`, 400);
  }
  const sorted = sortTiers(tiers);
  if (new Set(sorted.map((t) => t.above)).size !== sorted.length)
    throw new CustomError(`${label}: hay dos tramos con el mismo excedente`, 400);
  sorted[0].above = 0;
  return sorted;
}

export async function updateRule(body: any) {
  const set: Record<string, unknown> = {};
  if (body?.dailyBase !== undefined) {
    const n = Number(body.dailyBase);
    if (!Number.isInteger(n) || n < 0) throw new CustomError("La base diaria debe estar en centavos", 400);
    set.dailyBase = n;
  }
  if (body?.supervisorPercent !== undefined) {
    const n = Number(body.supervisorPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      throw new CustomError("El % del supervisor debe estar entre 0 y 100", 400);
    set.supervisorPercent = n;
  }
  if (body?.tiers !== undefined) set.tiers = parseTiers(body.tiers, "Tramos");
  if (body?.exceptions !== undefined) {
    if (!Array.isArray(body.exceptions)) throw new CustomError("exceptions debe ser una lista", 400);
    const seen = new Set<string>();
    set.exceptions = body.exceptions.map((e: any) => {
      const op = assertObjectId(String(e?.operator ?? ""), "el operador");
      if (seen.has(op)) throw new CustomError("Un operador aparece dos veces en las excepciones", 400);
      seen.add(op);
      return { operator: new Types.ObjectId(op), tiers: parseTiers(e?.tiers, "Excepción"), note: str(e?.note, 300) };
    });
  }
  await CommissionRule.updateOne({ key: "main" }, { $set: set }, { upsert: true });
  return describeRule(await getRule());
}

async function describeRule(rule: Rule) {
  const users = await User.find({ _id: { $in: rule.exceptions.map((e) => e.operator) } })
    .select("name")
    .lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  return {
    ...rule,
    exceptions: rule.exceptions.map((e) => ({ ...e, name: names.get(e.operator) ?? "—" })),
  };
}

export async function getRuleView() {
  return describeRule(await getRule());
}

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------

interface Cell {
  production: number;
  excess: number;
  percent: number;
  fee: number;
  supervisorFee: number;
}

/** Producción por operador y día, total y por sucursal (centavos, sin redondear). */
async function productionByDay(from: string, to: string) {
  const bookings = await Booking.find({
    date: { $gte: from, $lte: to },
    status: { $nin: INACTIVE_STATUSES },
    "operators.0": { $exists: true },
  })
    .select("date total operators branch")
    .lean();
  const acc = new Map<string, { date: string; operator: string; total: number; byBranch: Map<string, number> }>();
  for (const b of bookings) {
    // Dos lavadores en un servicio: el monto se reparte, igual que el reporte de producción.
    const share = b.total / b.operators.length;
    for (const op of b.operators) {
      const key = `${b.date}|${String(op)}`;
      const row = acc.get(key) ?? { date: b.date, operator: String(op), total: 0, byBranch: new Map() };
      row.total += share;
      row.byBranch.set(String(b.branch), (row.byBranch.get(String(b.branch)) ?? 0) + share);
      acc.set(key, row);
    }
  }
  return [...acc.values()];
}

/**
 * Celdas día × operador ya repartidas a las sucursales pedidas (`branches` vacío = todas).
 */
async function computeCells(from: string, to: string, branches: string[]) {
  const [rule, rows] = await Promise.all([getRule(), productionByDay(from, to)]);
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => r.operator))] } })
    .select("commissions")
    .lean();
  const noCommission = new Set(users.filter((u) => u.commissions === false).map((u) => String(u._id)));
  const exceptions = new Map(rule.exceptions.map((e) => [e.operator, e.tiers]));

  const cells: { date: string; operator: string; cell: Cell }[] = [];
  for (const r of rows) {
    const inScope = branches.length
      ? branches.reduce((s, b) => s + (r.byBranch.get(b) ?? 0), 0)
      : r.total;
    if (inScope <= 0) continue;
    const factor = r.total > 0 ? inScope / r.total : 0;
    const production = Math.round(r.total);
    const excess = production - rule.dailyBase;
    const earns = excess > 0 && !noCommission.has(r.operator);
    const percent = earns ? percentFor(excess, exceptions.get(r.operator) ?? rule.tiers) : 0;
    const fee = earns ? (excess * percent) / 100 : 0;
    const supervisorFee = earns ? (excess * rule.supervisorPercent) / 100 : 0;
    cells.push({
      date: r.date,
      operator: r.operator,
      cell: {
        production: Math.round(production * factor),
        excess: Math.round(excess * factor),
        percent,
        fee: Math.round(fee * factor),
        supervisorFee: Math.round(supervisorFee * factor),
      },
    });
  }
  return { rule, cells };
}

function adjustmentFilter(from: string, to: string, branches: string[]) {
  return {
    date: { $gte: from, $lte: to },
    ...(branches.length ? { branch: { $in: branches.map((b) => new Types.ObjectId(b)) } } : {}),
  };
}

/** Sucursales del alcance: la pedida, las del manager o todas (admin, lista vacía). */
function scopeBranches(user: SessionUser, requested: unknown): string[] {
  const f = branchFilter(user, requested);
  if (!f.branch) return [];
  if (f.branch.$in) return f.branch.$in.map(String);
  return [String(f.branch)];
}

/**
 * Totales por mes del año (centavos) para el estado de resultados. Firma acordada con
 * el módulo de finanzas: no cambiarla.
 */
export async function commissionTotalsByMonth(
  year: number,
  branchId?: string,
): Promise<{ month: number; operators: number; supervisor: number; total: number }[]> {
  const rows = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, operators: 0, supervisor: 0, total: 0 }));
  const branches = branchId && isValidObjectId(branchId) ? [branchId] : [];
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [{ cells }, adjustments] = await Promise.all([
    computeCells(from, to, branches),
    CommissionAdjustment.find(adjustmentFilter(from, to, branches)).select("date kind amount").lean(),
  ]);
  for (const { date, cell } of cells) {
    const row = rows[Number(date.slice(5, 7)) - 1];
    row.operators += cell.fee;
    row.supervisor += cell.supervisorFee;
  }
  for (const a of adjustments) {
    const row = rows[Number(a.date.slice(5, 7)) - 1];
    if (a.kind === "supervisor") row.supervisor += a.amount;
    else row.operators += a.amount;
  }
  for (const r of rows) r.total = r.operators + r.supervisor;
  return rows;
}

/** GET /admin/commissions?month=&branch= — la hoja FEE del mes con totales por quincena. */
export async function monthSheet(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const branches = scopeBranches(user, query?.branch);
  const { from, to } = monthBounds(month);
  const [{ rule, cells }, adjustments] = await Promise.all([
    computeCells(from, to, branches),
    CommissionAdjustment.find(adjustmentFilter(from, to, branches)).sort({ date: 1, createdAt: 1 }).lean(),
  ]);

  const opIds = new Set([...cells.map((c) => c.operator), ...adjustments.map((a) => String(a.operator))]);
  const people = await User.find({ _id: { $in: [...opIds] } })
    .select("name color supervisor position")
    .lean();
  const fallbackSupervisor = await User.findOne({ position: "supervisor", active: true }).select("name").lean();
  const supIds = people.map((p) => p.supervisor).filter(Boolean);
  const supervisors = await User.find({ _id: { $in: supIds } }).select("name").lean();
  const supName = new Map(supervisors.map((s) => [String(s._id), s.name]));
  const personMap = new Map(people.map((p) => [String(p._id), p]));

  const operators = people
    .filter((p) => cells.some((c) => c.operator === String(p._id)))
    .map((p) => {
      const sup = p.supervisor ? String(p.supervisor) : fallbackSupervisor ? String(fallbackSupervisor._id) : null;
      const name = p.supervisor ? supName.get(String(p.supervisor)) : fallbackSupervisor?.name;
      return { _id: String(p._id), name: p.name, color: p.color, supervisor: sup, supervisorName: name ?? "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  const zeroQ = () => ({ fee: 0, supervisorFee: 0, adjustments: 0 });
  const totals = new Map(
    operators.map((o) => [o._id, { operator: o._id, name: o.name, production: 0, fee: 0, supervisorFee: 0, adjustments: 0, total: 0, q1: zeroQ(), q2: zeroQ() }]),
  );
  const byDate = new Map<string, Record<string, Cell>>();
  const supTotals = new Map<string, { supervisor: string | null; name: string; q1: number; q2: number; total: number }>();
  const supKey = (id: string | null, name: string) => {
    const k = id ?? "none";
    if (!supTotals.has(k)) supTotals.set(k, { supervisor: id, name: name || "Sin supervisor asignado", q1: 0, q2: 0, total: 0 });
    return supTotals.get(k)!;
  };

  for (const { date, operator, cell } of cells) {
    const day = byDate.get(date) ?? {};
    day[operator] = cell;
    byDate.set(date, day);
    const t = totals.get(operator);
    if (!t) continue;
    const q = fortnightOf(date) === 1 ? t.q1 : t.q2;
    t.production += cell.production;
    t.fee += cell.fee;
    t.supervisorFee += cell.supervisorFee;
    q.fee += cell.fee;
    q.supervisorFee += cell.supervisorFee;
    const op = operators.find((o) => o._id === operator)!;
    const s = supKey(op.supervisor, op.supervisorName);
    s[fortnightOf(date) === 1 ? "q1" : "q2"] += cell.supervisorFee;
    s.total += cell.supervisorFee;
  }

  const adjViews = adjustments.map((a) => {
    const id = String(a.operator);
    const name = personMap.get(id)?.name ?? "—";
    if (a.kind === "supervisor") {
      const s = supKey(id, name);
      s[fortnightOf(a.date) === 1 ? "q1" : "q2"] += a.amount;
      s.total += a.amount;
    } else {
      const t = totals.get(id);
      if (t) {
        t.adjustments += a.amount;
        (fortnightOf(a.date) === 1 ? t.q1 : t.q2).adjustments += a.amount;
      }
    }
    return { _id: String(a._id), date: a.date, operator: id, name, kind: a.kind, amount: a.amount, note: a.note, createdBy: a.createdBy };
  });

  const totalRows = [...totals.values()].map((t) => ({ ...t, total: t.fee + t.adjustments }));
  const sum = (fn: (t: (typeof totalRows)[number]) => number) => totalRows.reduce((s, t) => s + fn(t), 0);
  const supList = [...supTotals.values()];
  const supSum = (k: "q1" | "q2" | "total") => supList.reduce((s, x) => s + x[k], 0);
  const opQ = (q: "q1" | "q2") => sum((t) => t[q].fee + t[q].adjustments);

  return {
    month,
    from,
    to,
    rule: await describeRule(rule),
    operators,
    days: daysBetween(from, to).map((date) => ({ date, cells: byDate.get(date) ?? {} })),
    totals: totalRows,
    supervisors: supList,
    adjustments: adjViews,
    summary: {
      production: sum((t) => t.production),
      operators: sum((t) => t.total),
      supervisor: supSum("total"),
      total: sum((t) => t.total) + supSum("total"),
      q1: { operators: opQ("q1"), supervisor: supSum("q1"), total: opQ("q1") + supSum("q1") },
      q2: { operators: opQ("q2"), supervisor: supSum("q2"), total: opQ("q2") + supSum("q2") },
    },
  };
}

export async function addAdjustment(body: any, user: SessionUser) {
  if (!isValidDate(body?.date)) throw new CustomError("Elige la fecha del ajuste", 400);
  const operatorId = assertObjectId(String(body?.operator ?? ""), "el operador");
  const amount = Number(body?.amount);
  if (!Number.isInteger(amount) || amount === 0)
    throw new CustomError("El ajuste debe ser un valor en centavos distinto de 0", 400);
  const note = str(body?.note, 300);
  if (!note) throw new CustomError("Escribe el motivo del ajuste", 400);
  const kind = body?.kind === "supervisor" ? "supervisor" : "operator";
  const person = await User.findById(operatorId).select("branches").lean();
  if (!person) throw new CustomError("Operador no encontrado", 404);
  const branch = person.branches?.[0] ?? null;
  if (user.role !== "admin") assertBranchAccess(user, branch);
  const doc = await CommissionAdjustment.create({
    date: body.date,
    operator: operatorId,
    branch,
    kind,
    amount,
    note,
    createdBy: actor(user),
  });
  return doc.toObject();
}

export async function deleteAdjustment(id: string, user: SessionUser) {
  assertObjectId(id, "el ajuste");
  const doc = await CommissionAdjustment.findById(id);
  if (!doc) throw new CustomError("Ajuste no encontrado", 404);
  if (user.role !== "admin") assertBranchAccess(user, doc.branch);
  await doc.deleteOne();
  return { ok: true };
}
