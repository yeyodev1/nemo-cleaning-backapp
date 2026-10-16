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
import { Branch } from "../models/branch.model";
import { Goal } from "../models/goal.model";
import { manualTotalsByMonth } from "./commissionEntry.service";
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
 * SOLO REFERENCIA ("Calculadora FEE" del panel): los reportes usan las comisiones manuales
 * (`commissionEntry.service.ts`). "Usar este valor" copia el FEE a la celda manual.
 */

/**
 * Fechas del período de un mes. Día 1 = mes calendario. Día 16 = del 16 del mes anterior
 * al 15 del mes (como el reporte quincenal del Excel: "agosto" = 16 jul–15 ago).
 */
function periodBounds(month: string, startDay: 1 | 16): { from: string; to: string } {
  if (startDay === 1) return monthBounds(month);
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  return { from: `${prev}-16`, to: `${month}-15` };
}

function monthParam(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return currentMonth();
  if (!isValidMonth(raw)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  return raw;
}

type Rule = {
  dailyBase: number;
  tiers: ICommissionTier[];
  supervisorPercent: number;
  periodStartDay: 1 | 16;
  productionBasis: "total" | "subtotal";
  supervisorMode: "percent" | "fixed";
  supervisorFixed: number;
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
    periodStartDay: doc!.periodStartDay === 16 ? 16 : 1,
    productionBasis: doc!.productionBasis === "subtotal" ? "subtotal" : "total",
    supervisorMode: doc!.supervisorMode === "fixed" ? "fixed" : "percent",
    supervisorFixed: doc!.supervisorFixed ?? 0,
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
  if (body?.branchPercents !== undefined) {
    if (!Array.isArray(body.branchPercents)) throw new CustomError("branchPercents debe ser una lista", 400);
    set.branchPercents = body.branchPercents.map((b: any) => {
      const percent = Number(b?.percent);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new CustomError("El % de cada sucursal debe estar entre 0 y 100", 400);
      return { branch: new Types.ObjectId(assertObjectId(String(b?.branch ?? ""), "la sucursal")), percent };
    });
  }
  if (body?.periodStartDay !== undefined) {
    if (![1, 16].includes(Number(body.periodStartDay))) throw new CustomError("El período empieza el día 1 o el 16", 400);
    set.periodStartDay = Number(body.periodStartDay);
  }
  if (body?.productionBasis !== undefined) {
    if (!["total", "subtotal"].includes(String(body.productionBasis))) throw new CustomError("Base de producción inválida", 400);
    set.productionBasis = String(body.productionBasis);
  }
  if (body?.supervisorMode !== undefined) {
    if (!["percent", "fixed"].includes(String(body.supervisorMode))) throw new CustomError("Modo del supervisor inválido", 400);
    set.supervisorMode = String(body.supervisorMode);
  }
  if (body?.supervisorFixed !== undefined) {
    const n = Number(body.supervisorFixed);
    if (!Number.isInteger(n) || n < 0) throw new CustomError("El monto fijo del supervisor debe estar en centavos", 400);
    set.supervisorFixed = n;
  }
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

/**
 * % por sucursal para la comisión por meta. Sin configurar: Samborondón 30 %, el resto 20 %
 * (Vía a la Costa / Ceibos), como lo definió gerencia.
 */
export async function branchPercents(): Promise<{ branch: string; name: string; percent: number }[]> {
  const [doc, branches] = await Promise.all([
    CommissionRule.findOne({ key: "main" }).select("branchPercents").lean(),
    Branch.find().select("name").sort({ name: 1 }).lean(),
  ]);
  const saved = new Map((doc?.branchPercents ?? []).map((b) => [String(b.branch), b.percent]));
  return branches.map((b) => ({
    branch: String(b._id),
    name: b.name,
    percent: saved.get(String(b._id)) ?? (/samborond/i.test(b.name) ? 30 : 20),
  }));
}

/**
 * GET /admin/commissions/goal-sheet?month=&branch= — comisión por meta mensual:
 *   EXCEDENTE = producción del mes del operador − su meta del mes (Metas mensuales)
 *   COMISIÓN = excedente × % de la sucursal (si trabajó en varias, el excedente se reparte
 *   según lo que produjo en cada una).
 */
export async function goalSheet(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const branches = scopeBranches(user, query?.branch);
  const rule = await getRule();
  const { from, to } = monthBounds(month);
  const [rows, percents, goals] = await Promise.all([
    productionByDay(from, to, rule.productionBasis),
    branchPercents(),
    Goal.find({ month }).lean(),
  ]);
  const pct = new Map(percents.map((p) => [p.branch, p]));
  const goalOf = new Map(goals.map((g) => [String(g.operator), g.amount]));

  const acc = new Map<string, { total: number; byBranch: Map<string, number> }>();
  for (const r of rows) {
    const a = acc.get(r.operator) ?? { total: 0, byBranch: new Map() };
    a.total += r.total;
    for (const [b, v] of r.byBranch) a.byBranch.set(b, (a.byBranch.get(b) ?? 0) + v);
    acc.set(r.operator, a);
  }
  // Metas puestas para operadores sin producción aún también se muestran.
  for (const g of goals) if (!acc.has(String(g.operator))) acc.set(String(g.operator), { total: 0, byBranch: new Map() });

  const people = await User.find({ _id: { $in: [...acc.keys()] } }).select("name color role branches").lean();
  const personMap = new Map(people.map((p) => [String(p._id), p]));

  const items = [...acc.entries()]
    .map(([operator, a]) => {
      const p = personMap.get(operator);
      const production = Math.round(a.total);
      const goal = goalOf.get(operator) ?? null;
      const excess = goal === null ? 0 : Math.max(0, production - goal);
      const parts = [...a.byBranch.entries()]
        .filter(([b]) => !branches.length || branches.includes(b))
        .map(([b, v]) => {
          const share = a.total > 0 ? v / a.total : 0;
          const percent = pct.get(b)?.percent ?? 20;
          const branchExcess = excess * share;
          return { branch: b, name: pct.get(b)?.name ?? "—", production: Math.round(v), excess: Math.round(branchExcess), percent, commission: Math.round((branchExcess * percent) / 100) };
        });
      // Sin producción (solo meta) en el alcance: se muestra con su sucursal principal.
      if (!parts.length && (!branches.length || (p?.branches ?? []).some((b) => branches.includes(String(b))))) {
        const b = String(p?.branches?.[0] ?? "");
        parts.push({ branch: b, name: pct.get(b)?.name ?? "—", production: 0, excess: 0, percent: pct.get(b)?.percent ?? 20, commission: 0 });
      }
      return {
        operator,
        name: p?.name ?? "—",
        color: p?.color ?? "",
        goal,
        production,
        excess,
        progress: goal ? Math.round((production / goal) * 100) : null,
        branches: parts,
        commission: parts.reduce((s, x) => s + x.commission, 0),
      };
    })
    .filter((i) => i.branches.length && personMap.get(i.operator)?.role === "operator")
    .sort((a, b) => b.commission - a.commission || b.production - a.production);

  return {
    month,
    from,
    to,
    percents,
    basis: rule.productionBasis,
    items,
    summary: {
      production: items.reduce((s, i) => s + i.production, 0),
      commission: items.reduce((s, i) => s + i.commission, 0),
      withGoal: items.filter((i) => i.goal !== null).length,
      withoutGoal: items.filter((i) => i.goal === null).length,
      overGoal: items.filter((i) => i.excess > 0).length,
    },
  };
}

async function describeRule(rule: Rule) {
  const users = await User.find({ _id: { $in: rule.exceptions.map((e) => e.operator) } })
    .select("name")
    .lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  return {
    ...rule,
    exceptions: rule.exceptions.map((e) => ({ ...e, name: names.get(e.operator) ?? "—" })),
    branchPercents: await branchPercents(),
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
async function productionByDay(from: string, to: string, basis: "total" | "subtotal") {
  const bookings = await Booking.find({
    date: { $gte: from, $lte: to },
    status: { $nin: INACTIVE_STATUSES },
    "operators.0": { $exists: true },
  })
    .select("date total subtotal operators branch")
    .lean();
  const acc = new Map<string, { date: string; operator: string; total: number; byBranch: Map<string, number> }>();
  for (const b of bookings) {
    // Dos lavadores en un servicio: el monto se reparte, igual que el reporte de producción.
    const amount = basis === "subtotal" ? (b.subtotal ?? b.total) : b.total;
    const share = amount / b.operators.length;
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
  const rule = await getRule();
  const rows = await productionByDay(from, to, rule.productionBasis);
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
    const supervisorFee = earns && rule.supervisorMode === "percent" ? (excess * rule.supervisorPercent) / 100 : 0;
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
 * el módulo de finanzas: no cambiarla. Desde 2026-10 devuelve las comisiones MANUALES
 * (hoja "Comisiones" que escribe gerencia, `CommissionEntry`): el FEE calculado de abajo
 * es solo una referencia y no entra a ningún reporte. `supervisor` queda en 0.
 */
export async function commissionTotalsByMonth(
  year: number,
  branchId?: string,
): Promise<{ month: number; operators: number; supervisor: number; total: number }[]> {
  const totals = await manualTotalsByMonth(year, branchId && isValidObjectId(branchId) ? branchId : undefined);
  return totals.map((total, i) => ({ month: i + 1, operators: total, supervisor: 0, total }));
}

/** GET /admin/commissions?month=&branch= — la hoja FEE del mes con totales por quincena. */
export async function monthSheet(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const branches = scopeBranches(user, query?.branch);
  const periodRule = await getRule();
  const { from, to } = periodBounds(month, periodRule.periodStartDay);
  // Quincena dentro del período: la primera mitad es Q1 (en 16→15, Q1 = del 16 a fin de mes).
  const fortnightOf = (date: string) => (periodRule.periodStartDay === 16 ? (date.slice(0, 7) < month ? 1 : 2) : Number(date.slice(8, 10)) <= 15 ? 1 : 2);
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

  // Supervisor con monto fijo: cada supervisor con operadores en el período cobra ese monto (mitad por quincena).
  if (rule.supervisorMode === "fixed" && rule.supervisorFixed > 0) {
    const seen = new Set<string>();
    for (const op of operators) {
      const key = op.supervisor ?? "none";
      if (seen.has(key) || !cells.some((c) => c.operator === op._id)) continue;
      seen.add(key);
      const s = supKey(op.supervisor, op.supervisorName);
      const half = Math.round(rule.supervisorFixed / 2);
      s.q1 += half;
      s.q2 += rule.supervisorFixed - half;
      s.total += rule.supervisorFixed;
    }
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
