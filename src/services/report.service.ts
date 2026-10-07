import { CustomError } from "../errors/customError.error";
import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { Expense } from "../models/expense.model";
import { OfficeQuote } from "../models/officeQuote.model";
import { Payment } from "../models/payment.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import {
  currentMonth,
  dateStrOf,
  dayRange,
  daysBetween,
  isValidDate,
  isValidMonth,
  monthBounds,
  parseRange,
  todayStr,
} from "../utils/date";
import { branchFilter } from "../utils/scope";
import { RECEIVABLE_MATCH } from "../utils/paymentAccount";

/**
 * Regla de negocio: ingreso = pagos aprobados (paidAt), no el total de los
 * pedidos. Producción = pedidos agendados en el rango que no se cancelaron.
 */

const METHODS = ["card", "cash", "transfer"] as const;

async function approvedPayments(scope: Record<string, any>, start: Date, end: Date) {
  return Payment.find({ ...scope, status: "approved", paidAt: { $gte: start, $lt: end } })
    .select("amount method paidAt booking branch")
    .lean();
}

function sumBy<T>(rows: T[], fn: (r: T) => number): number {
  return rows.reduce((s, r) => s + fn(r), 0);
}

function byMethod(payments: { method: string; amount: number }[]) {
  const out: Record<string, number> = { card: 0, cash: 0, transfer: 0 };
  for (const p of payments) out[p.method] = (out[p.method] ?? 0) + p.amount;
  return out;
}

/** Reparte cada pago entre las líneas de su pedido según el peso de cada subtotal. */
async function incomeByService(payments: { booking: any; amount: number }[]) {
  const ids = [...new Set(payments.map((p) => String(p.booking)))];
  const bookings = await Booking.find({ _id: { $in: ids } })
    .select("items subtotal")
    .lean();
  const map = new Map(bookings.map((b) => [String(b._id), b]));
  const acc = new Map<string, { service: string | null; name: string; amount: number }>();
  for (const p of payments) {
    const b = map.get(String(p.booking));
    if (!b || !b.items.length) continue;
    const base = sumBy(b.items, (i) => i.subtotal) || 1;
    for (const item of b.items) {
      const key = item.service ? String(item.service) : `libre:${item.name}`;
      const row = acc.get(key) ?? {
        service: item.service ? String(item.service) : null,
        name: item.name,
        amount: 0,
      };
      row.amount += (p.amount * item.subtotal) / base;
      acc.set(key, row);
    }
  }
  return [...acc.values()]
    .map((r) => ({ ...r, amount: Math.round(r.amount) }))
    .sort((a, b) => b.amount - a.amount);
}

async function production(scope: Record<string, any>, from: string, to: string) {
  const bookings = await Booking.find({
    ...scope,
    date: { $gte: from, $lte: to },
    status: { $nin: INACTIVE_STATUSES },
  })
    .select("items total date operators")
    .lean();

  const services = new Map<
    string,
    { service: string | null; name: string; quantity: number; amount: number }
  >();
  const operators = new Map<string, { operator: string; bookings: number; amount: number }>();
  const days = new Map<string, { date: string; bookings: number; amount: number }>();

  for (const b of bookings) {
    for (const i of b.items) {
      const key = i.service ? String(i.service) : `libre:${i.name}`;
      const row = services.get(key) ?? {
        service: i.service ? String(i.service) : null,
        name: i.name,
        quantity: 0,
        amount: 0,
      };
      row.quantity += i.quantity;
      row.amount += i.subtotal;
      services.set(key, row);
    }
    // Con dos lavadores en un servicio, el monto se reparte para no contarlo doble.
    const share = b.operators.length ? b.total / b.operators.length : 0;
    for (const op of b.operators) {
      const row = operators.get(String(op)) ?? { operator: String(op), bookings: 0, amount: 0 };
      row.bookings += 1;
      row.amount += share;
      operators.set(String(op), row);
    }
    const d = days.get(b.date) ?? { date: b.date, bookings: 0, amount: 0 };
    d.bookings += 1;
    d.amount += b.total;
    days.set(b.date, d);
  }

  const users = await User.find({ _id: { $in: [...operators.keys()] } })
    .select("name color")
    .lean();
  const names = new Map(users.map((u) => [String(u._id), u]));

  return {
    bookings,
    byService: [...services.values()].sort((a, b) => b.amount - a.amount),
    byOperator: [...operators.values()]
      .map((r) => ({
        ...r,
        name: names.get(r.operator)?.name ?? "—",
        color: names.get(r.operator)?.color ?? "",
        amount: Math.round(r.amount),
      }))
      .sort((a, b) => b.amount - a.amount),
    byDay: daysBetween(from, to).map((date) => days.get(date) ?? { date, bookings: 0, amount: 0 }),
  };
}

export async function productionReport(user: SessionUser, query: any) {
  const { from, to } = parseRange(query?.from, query?.to);
  const p = await production(branchFilter(user, query?.branch), from, to);
  return { from, to, byService: p.byService, byOperator: p.byOperator, byDay: p.byDay };
}

export async function incomeStatement(user: SessionUser, query: any) {
  const month = query?.month ? String(query.month) : currentMonth();
  if (!isValidMonth(month)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  const { from, to } = monthBounds(month);
  const scope = branchFilter(user, query?.branch);
  const payments = await approvedPayments(scope, dayRange(from).start, dayRange(to).end);

  const expenseFilter = { ...scope, date: { $gte: from, $lte: to } };
  const expenses = await Expense.find(expenseFilter).select("amount category paidFrom").lean();
  const categories = new Map<string, number>();
  for (const e of expenses)
    categories.set(e.category, (categories.get(e.category) ?? 0) + e.amount);

  const incomeTotal = sumBy(payments, (p) => p.amount);
  const expenseTotal = sumBy(expenses, (e) => e.amount);
  return {
    month,
    income: {
      total: incomeTotal,
      byMethod: byMethod(payments),
      byService: await incomeByService(payments),
    },
    expenses: {
      total: expenseTotal,
      byCategory: [...categories.entries()]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
      pettyCash: sumBy(
        expenses.filter((e) => e.paidFrom === "petty_cash"),
        (e) => e.amount,
      ),
      management: sumBy(
        expenses.filter((e) => e.paidFrom === "management"),
        (e) => e.amount,
      ),
    },
    net: incomeTotal - expenseTotal,
  };
}

/** Registro de caja del día: cobros por método, gastos de caja menor y saldo en efectivo. */
export async function cashReport(user: SessionUser, query: any) {
  const date = isValidDate(query?.date) ? query.date : todayStr();
  const scope = branchFilter(user, query?.branch);
  const { start, end } = dayRange(date);
  const [payments, expenses] = await Promise.all([
    Payment.find({ ...scope, status: "approved", paidAt: { $gte: start, $lt: end } })
      .sort({ paidAt: 1 })
      .populate("customer", "name")
      .lean(),
    Expense.find({ ...scope, date, paidFrom: "petty_cash" })
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  const methods = byMethod(payments);
  const expensesTotal = sumBy(expenses, (e) => e.amount);
  return {
    date,
    income: { total: sumBy(payments, (p) => p.amount), byMethod: methods, count: payments.length },
    pettyCashExpenses: { total: expensesTotal, items: expenses },
    // Efectivo que debería haber en caja: cobros en efectivo menos gastos de caja menor del día.
    balance: methods.cash - expensesTotal,
    payments,
  };
}

/** Producción de hoy, de la quincena (Q1 1–15 / Q2 16–fin) y del mes calendario en curso. */
async function productionSnapshot(scope: Record<string, any>, today: string) {
  const month = today.slice(0, 7);
  const q = Number(today.slice(8, 10)) <= 15 ? 1 : 2;
  const qFrom = q === 1 ? `${month}-01` : `${month}-16`;
  const rows = await Booking.aggregate<{ _id: string; total: number; count: number }>([
    {
      $match: {
        ...scope,
        date: { $gte: `${month}-01`, $lte: `${month}-31` },
        status: { $nin: INACTIVE_STATUSES },
      },
    },
    { $group: { _id: "$date", total: { $sum: "$total" }, count: { $sum: 1 } } },
  ]);
  const sum = (fn: (d: string) => boolean) =>
    rows.filter((r) => fn(r._id)).reduce((a, r) => ({ amount: a.amount + r.total, bookings: a.bookings + r.count }), {
      amount: 0,
      bookings: 0,
    });
  return {
    fortnight: q,
    fortnightFrom: qFrom,
    today: sum((d) => d === today),
    fortnightToDate: sum((d) => d >= qFrom && d <= today),
    monthToDate: sum((d) => d <= today),
    // Lo agendado que falta del mes (pedidos futuros ya cargados).
    monthScheduled: sum((d) => d > today),
  };
}

export async function dashboard(user: SessionUser, query: any) {
  const scope = branchFilter(user, query?.branch);
  const { from, to, start, end } = parseRange(query?.from, query?.to);
  const today = todayStr();
  const todayRange = dayRange(today);

  const [
    todayBookings,
    todayPayments,
    periodPayments,
    periodExpenses,
    pendingTransfers,
    receivables,
    newOfficeQuotes,
    prod,
    upcoming,
    toConfirm,
    productionNow,
    whatsappPending,
  ] = await Promise.all([
    Booking.find({ ...scope, date: today, status: { $nin: INACTIVE_STATUSES } })
      .select("status")
      .lean(),
    approvedPayments(scope, todayRange.start, todayRange.end),
    approvedPayments(scope, start, end),
    Expense.aggregate<{ total: number }>([
      { $match: { ...scope, date: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Payment.countDocuments({ ...scope, status: "review" }),
    Booking.aggregate<{ total: number }>([
      { $match: { ...scope, status: { $nin: INACTIVE_STATUSES }, date: { $lte: today }, ...RECEIVABLE_MATCH } },
      { $group: { _id: null, total: { $sum: "$balance" } } },
    ]),
    OfficeQuote.countDocuments({
      status: "new",
      ...(user.role === "admin" && !scope.branch
        ? {}
        : scope.branch
          ? { branch: { $in: [null, ...(scope.branch.$in ?? [scope.branch])] } }
          : {}),
    }),
    production(scope, from, to),
    Booking.find({
      ...scope,
      startAt: { $gte: new Date() },
      status: { $in: ["pending", "confirmed"] },
    })
      .sort({ startAt: 1 })
      .limit(5)
      .populate([
        { path: "customer", select: "name email phone" },
        { path: "operators", select: "name color" },
      ])
      .lean(),
    Payment.aggregate<{ total: number }>([
      { $match: { ...scope, status: "review" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    productionSnapshot(scope, today),
    // Pedidos que terminaron en WhatsApp y nadie confirmó aún (tarjeta de aviso del Inicio).
    Booking.countDocuments({ ...scope, source: "whatsapp", status: "pending" }),
  ]);

  const incomeByDayMap = new Map<string, number>();
  for (const p of periodPayments) {
    const d = dateStrOf(new Date(p.paidAt!));
    incomeByDayMap.set(d, (incomeByDayMap.get(d) ?? 0) + p.amount);
  }
  const income = sumBy(periodPayments, (p) => p.amount);
  const expenses = periodExpenses[0]?.total ?? 0;
  const periodBookings = prod.bookings.length;
  const bookedTotal = sumBy(prod.bookings, (b) => b.total);

  return {
    from,
    to,
    today: {
      bookings: todayBookings.length,
      completed: todayBookings.filter((b) => b.status === "completed").length,
      pending: todayBookings.filter((b) => b.status === "pending").length,
      income: sumBy(todayPayments, (p) => p.amount),
    },
    period: {
      bookings: periodBookings,
      income,
      expenses,
      net: income - expenses,
      averageTicket: periodBookings ? Math.round(bookedTotal / periodBookings) : 0,
    },
    pendingTransfers,
    // Monto de transferencias en revisión ("Por confirmar"): no es deuda del cliente.
    toConfirm: toConfirm[0]?.total ?? 0,
    receivables: receivables[0]?.total ?? 0,
    // Producción (lo facturado por servicios hechos) de hoy, la quincena y el mes en curso.
    production: productionNow,
    newOfficeQuotes,
    whatsappPending,
    incomeByDay: daysBetween(from, to).map((date) => ({
      date,
      amount: incomeByDayMap.get(date) ?? 0,
    })),
    topServices: prod.byService
      .slice(0, 5)
      .map(({ name, quantity, amount }) => ({ name, quantity, amount })),
    byOperator: prod.byOperator.map(({ operator, name, color, bookings, amount }) => ({
      operator,
      name,
      color,
      bookings,
      amount,
    })),
    upcoming,
  };
}
