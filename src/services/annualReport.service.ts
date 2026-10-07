import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { Expense } from "../models/expense.model";
import { Payment } from "../models/payment.model";
import { PayrollEntry } from "../models/payrollEntry.model";
import { SessionUser } from "../types/AuthRequest";
import { dateStrOf, dayRange, monthBounds } from "../utils/date";
import { monthParam, yearParam } from "../utils/fortnight";
import { branchFilter } from "../utils/scope";
import { commissionTotalsByMonth } from "./commission.service";

/**
 * Estado de resultados (hojas "Resumen Anual" y "Detalle Mensual" del Excel):
 *   Ventas = PRODUCCIÓN (pedidos realizados por su fecha, no lo cobrado; lo cobrado va aparte).
 *   Sueldos = sueldo del mes en Nómina + gastos de categoría "sueldos".
 *   Gastos variables / fijos = gastos según su tipo, SIN anticipos (ya están dentro del sueldo)
 *   ni propinas (salen de caja pero entraron por cuenta: no son gasto de la empresa).
 *   Comisiones = commissionTotalsByMonth (FEE de operadores + supervisor).
 *   Total gastos = sueldos + variables + fijos + comisiones; Utilidad neta = ventas − total gastos;
 *   Margen neto = utilidad / ventas; Gastos/ventas = total gastos / ventas.
 */

const EXCLUDED = ["anticipos", "propinas", "sueldos"];

interface MonthRow {
  month: number;
  sales: number;
  collected: number;
  salaries: number;
  variable: number;
  fixed: number;
  commissions: number;
  totalExpenses: number;
  net: number;
  margin: number;
  expenseRatio: number;
  payrollLoaded: boolean;
}

function finish(r: Omit<MonthRow, "totalExpenses" | "net" | "margin" | "expenseRatio">): MonthRow {
  const totalExpenses = r.salaries + r.variable + r.fixed + r.commissions;
  const net = r.sales - totalExpenses;
  return {
    ...r,
    totalExpenses,
    net,
    margin: r.sales ? net / r.sales : 0,
    expenseRatio: r.sales ? totalExpenses / r.sales : 0,
  };
}

/** Un solo id de sucursal para la función de comisiones (gerencia "todas" = undefined). */
function branchId(scope: Record<string, any>): string | undefined {
  const b = scope.branch;
  if (!b) return undefined;
  return b.$in ? undefined : String(b);
}

async function commissions(year: number, scope: Record<string, any>) {
  // Manager con varias sucursales: suma la de cada una.
  if (scope.branch?.$in) {
    const parts = await Promise.all(
      (scope.branch.$in as unknown[]).map((id) => commissionTotalsByMonth(year, String(id))),
    );
    return Array.from({ length: 12 }, (_, i) => parts.reduce((s, p) => s + (p[i]?.total ?? 0), 0));
  }
  const rows = await commissionTotalsByMonth(year, branchId(scope));
  return Array.from({ length: 12 }, (_, i) => rows.find((r) => r.month === i + 1)?.total ?? 0);
}

export async function annualStatement(user: SessionUser, query: any) {
  const year = yearParam(query?.year);
  const scope = branchFilter(user, query?.branch);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [bookings, payments, expenses, payroll, comm] = await Promise.all([
    Booking.find({ ...scope, date: { $gte: from, $lte: to }, status: { $nin: INACTIVE_STATUSES } })
      .select("date total")
      .lean(),
    Payment.find({
      ...scope,
      status: "approved",
      paidAt: { $gte: dayRange(from).start, $lt: dayRange(to).end },
    })
      .select("amount paidAt")
      .lean(),
    Expense.find({ ...scope, date: { $gte: from, $lte: to } })
      .select("date amount category kind")
      .lean(),
    PayrollEntry.find({ ...scope, month: { $gte: `${year}-01`, $lte: `${year}-12` } })
      .select("month salary")
      .lean(),
    commissions(year, scope),
  ]);

  const base = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    sales: 0,
    collected: 0,
    salaries: 0,
    variable: 0,
    fixed: 0,
    commissions: comm[i] ?? 0,
    payrollLoaded: false,
  }));
  const m = (date: string) => base[Number(date.slice(5, 7)) - 1];
  for (const b of bookings) m(b.date).sales += b.total;
  for (const p of payments) m(dateStrOf(new Date(p.paidAt!))).collected += p.amount;
  for (const e of payroll) {
    const row = m(`${e.month}-01`);
    row.salaries += e.salary;
    row.payrollLoaded = true;
  }
  for (const e of expenses) {
    const row = m(e.date);
    if (e.category === "sueldos") row.salaries += e.amount;
    else if (EXCLUDED.includes(e.category)) continue;
    else if (e.kind === "fixed") row.fixed += e.amount;
    else row.variable += e.amount;
  }
  const months = base.map(finish);
  const sum = (k: keyof MonthRow) => months.reduce((s, r) => s + (r[k] as number), 0);
  const total = finish({
    month: 0,
    sales: sum("sales"),
    collected: sum("collected"),
    salaries: sum("salaries"),
    variable: sum("variable"),
    fixed: sum("fixed"),
    commissions: sum("commissions"),
    payrollLoaded: months.some((r) => r.payrollLoaded),
  });
  return { year, months, total };
}

/** "Detalle Mensual": resumen del mes + detalle de sueldos, gastos variables y fijos con su %. */
export async function monthlyDetail(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const year = Number(month.slice(0, 4));
  const scope = branchFilter(user, query?.branch);
  const { from, to } = monthBounds(month);
  const [annual, payroll, expenses] = await Promise.all([
    annualStatement(user, { year, branch: query?.branch }),
    PayrollEntry.find({ ...scope, month }).sort({ name: 1 }).lean(),
    Expense.find({ ...scope, date: { $gte: from, $lte: to } })
      .sort({ date: 1 })
      .lean(),
  ]);
  const summary = annual.months[Number(month.slice(5, 7)) - 1];

  const salaryRows: { name: string; position: string; amount: number; source: string }[] =
    payroll.map((e) => ({ name: e.name, position: e.position, amount: e.salary, source: "payroll" }));
  for (const e of expenses.filter((x) => x.category === "sueldos"))
    salaryRows.push({ name: e.description, position: "", amount: e.amount, source: "expense" });

  const group = (kind: "variable" | "fixed") => {
    const rows = expenses.filter(
      (e) => !EXCLUDED.includes(e.category) && (e.kind === "fixed" ? "fixed" : "variable") === kind,
    );
    const cats = new Map<string, { category: string; amount: number; items: any[] }>();
    for (const e of rows) {
      const c = cats.get(e.category) ?? { category: e.category, amount: 0, items: [] };
      c.amount += e.amount;
      c.items.push({
        _id: e._id,
        date: e.date,
        description: e.description,
        amount: e.amount,
        installment: e.installment ?? null,
        recurring: e.recurring,
      });
      cats.set(e.category, c);
    }
    const total = rows.reduce((s, e) => s + e.amount, 0);
    return {
      total,
      categories: [...cats.values()]
        .map((c) => ({ ...c, share: total ? c.amount / total : 0 }))
        .sort((a, b) => b.amount - a.amount),
    };
  };
  const salaryTotal = salaryRows.reduce((s, r) => s + r.amount, 0);
  const excluded = expenses
    .filter((e) => e.category === "anticipos" || e.category === "propinas")
    .reduce(
      (acc, e) => ({ ...acc, [e.category]: (acc[e.category] ?? 0) + e.amount }),
      {} as Record<string, number>,
    );

  return {
    month,
    summary,
    salaries: {
      total: salaryTotal,
      rows: salaryRows.map((r) => ({ ...r, share: salaryTotal ? r.amount / salaryTotal : 0 })),
    },
    variable: group("variable"),
    fixed: group("fixed"),
    // Informativo: lo que no entra al estado de resultados y por qué.
    excluded,
  };
}
