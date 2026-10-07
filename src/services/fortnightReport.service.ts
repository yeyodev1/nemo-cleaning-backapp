import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { Expense } from "../models/expense.model";
import { Payable } from "../models/payable.model";
import { Payment } from "../models/payment.model";
import { SessionUser } from "../types/AuthRequest";
import { dateStrOf, dayRange, monthBounds } from "../utils/date";
import { QTotals, monthParam, qAdd, qRound, qZero } from "../utils/fortnight";
import { accountLabel, confirmationOf, tipOf } from "../utils/paymentAccount";
import { branchFilter } from "../utils/scope";
import { payablePendingCost } from "./payable.service";
import { payrollRows } from "./payroll.service";

/**
 * "REPORTE DE PAGOS Y UTILIDAD" (hojas AGOSTO / SEPTIEMBRE del Excel), por quincena.
 *
 * 1. Conciliación — sobre la PRODUCCIÓN de cada quincena (pedidos por su fecha de servicio):
 *    transferencias/tarjeta recibidas + efectivo disponible + efectivo desembolsado
 *    + por confirmar/cobrar + canje + perdidas − producción − propinas cobradas con el pago
 *    = diferencia de conciliación
 *    (igual a la fila 12 del Excel: B8+B9+B10+B11−B7). Efectivo disponible + desembolsado =
 *    efectivo cobrado, y desembolsado = gastos de caja menor pagados en efectivo en la quincena.
 *    Con todo registrado da 0; si no, hay pagos de más que no son propina.
 * 2. Cobrado — pagos aprobados por la fecha en que entró el dinero, por cuenta.
 * 3. Gastos por categoría, 4. Pagos por realizar (nómina + pagos), 5. Utilidad y liquidez:
 *    costos = gastos del periodo + nómina del mes (esperado) + lo PENDIENTE de los pagos por realizar;
 *    utilidad = producción − costos. Lo ya pagado de un pago por realizar está en gastos (se
 *    registra solo al marcarlo pagado) y los pagos de categoría nómina no suman: el sueldo
 *    viene de Nómina. Así nada cuenta dos veces.
 */

type AccountRow = { account: string } & QTotals;

function addAccount(map: Map<string, QTotals>, account: string, date: string, amount: number) {
  const t = map.get(account) ?? qZero();
  qAdd(t, date, amount);
  map.set(account, t);
}

function accountRows(map: Map<string, QTotals>): AccountRow[] {
  return [...map.entries()]
    .map(([account, t]) => ({ account, ...qRound(t) }))
    .sort((a, b) => b.total - a.total);
}

async function reconciliation(scope: Record<string, any>, from: string, to: string) {
  const bookings = await Booking.find({
    ...scope,
    date: { $gte: from, $lte: to },
    status: { $nin: INACTIVE_STATUSES },
  }).lean();
  const ids = bookings.map((b) => b._id);
  const payments = await Payment.find({ booking: { $in: ids }, status: { $in: ["approved", "review"] } })
    .select("booking amount method status account")
    .lean();
  const byBooking = new Map<string, typeof payments>();
  for (const p of payments) {
    const k = String(p.booking);
    byBooking.set(k, [...(byBooking.get(k) ?? []), p]);
  }

  const production = qZero();
  const received = qZero(); // transferencias + tarjeta
  const cashCollected = qZero();
  const toConfirm = qZero(); // transferencias en revisión
  const toCollect = qZero();
  const barter = qZero();
  const lost = qZero();
  const tips = qZero();
  const overpaid = qZero();
  const productionByAccount = new Map<string, QTotals>();
  const receivedByAccount = new Map<string, QTotals>();

  for (const b of bookings) {
    const d = b.date;
    qAdd(production, d, b.total);
    let approved = 0;
    let review = 0;
    for (const p of byBooking.get(String(b._id)) ?? []) {
      const account = accountLabel(p, b as any);
      if (p.status === "review") {
        review += p.amount;
        continue;
      }
      approved += p.amount;
      if (p.method === "cash") qAdd(cashCollected, d, p.amount);
      else {
        qAdd(received, d, p.amount);
        addAccount(receivedByAccount, account, d, p.amount);
      }
      addAccount(productionByAccount, account, d, p.amount);
    }
    const open = Math.max(0, b.total - approved);
    const inReview = Math.min(open, review);
    const rest = open - inReview;
    qAdd(toConfirm, d, inReview);
    const conf = confirmationOf(b as any);
    if (conf === "exchange") qAdd(barter, d, rest);
    else if (conf === "lost") qAdd(lost, d, rest);
    else qAdd(toCollect, d, rest);
    const extra = Math.max(0, approved - b.total);
    const tip = Math.min(extra, tipOf(b as any));
    qAdd(tips, d, tip);
    qAdd(overpaid, d, extra - tip);
  }
  return {
    production,
    received,
    cashCollected,
    toConfirm,
    toCollect,
    barter,
    lost,
    tips,
    overpaid,
    productionByAccount: accountRows(productionByAccount),
    receivedByAccount: accountRows(receivedByAccount),
    bookings: bookings.length,
  };
}

async function collected(scope: Record<string, any>, from: string, to: string) {
  const payments = await Payment.find({
    ...scope,
    status: "approved",
    paidAt: { $gte: dayRange(from).start, $lt: dayRange(to).end },
  })
    .select("booking amount method paidAt account")
    .lean();
  const bookings = await Booking.find({ _id: { $in: payments.map((p) => p.booking) } })
    .select("paymentAccount")
    .lean();
  const bmap = new Map(bookings.map((b) => [String(b._id), b]));
  const total = qZero();
  const byAccount = new Map<string, QTotals>();
  for (const p of payments) {
    const d = dateStrOf(new Date(p.paidAt!));
    qAdd(total, d, p.amount);
    addAccount(byAccount, accountLabel(p, bmap.get(String(p.booking)) as any), d, p.amount);
  }
  return { total: qRound(total), byAccount: accountRows(byAccount) };
}

async function expensesOf(scope: Record<string, any>, from: string, to: string) {
  const items = await Expense.find({ ...scope, date: { $gte: from, $lte: to } })
    .select("date category amount paidFrom paymentMethod")
    .lean();
  const cats = new Map<string, QTotals>();
  const total = qZero();
  const cashOut = qZero();
  for (const e of items) {
    const t = cats.get(e.category) ?? qZero();
    qAdd(t, e.date, e.amount);
    cats.set(e.category, t);
    qAdd(total, e.date, e.amount);
    // Lo que salió físicamente de la caja: caja menor pagada en efectivo.
    if (e.paidFrom === "petty_cash" && e.paymentMethod === "cash") qAdd(cashOut, e.date, e.amount);
  }
  return {
    byCategory: [...cats.entries()]
      .map(([category, t]) => ({ category, ...qRound(t) }))
      .sort((a, b) => b.total - a.total),
    total: qRound(total),
    cashOut,
  };
}

async function toPay(scope: Record<string, any>, month: string) {
  const [payroll, payables] = await Promise.all([
    payrollRows(month, scope),
    Payable.find({ month, ...scope }).sort({ fortnight: 1, dueDate: 1 }).lean(),
  ]);
  const total = qZero();
  const paid = qZero();
  const payrollTotal = qZero();
  const payrollPending = qZero();
  const payablesPending = qZero();
  for (const r of payroll) {
    payrollTotal.q1 += r.q1.expected;
    payrollTotal.q2 += r.q2.expected;
    payrollPending.q1 += Math.max(0, r.q1.expected - (r.q1.paid ?? 0));
    payrollPending.q2 += Math.max(0, r.q2.expected - (r.q2.paid ?? 0));
  }
  for (const p of payables) {
    const pend = payablePendingCost(p);
    if (p.fortnight === 1) payablesPending.q1 += pend;
    else payablesPending.q2 += pend;
  }
  for (const t of [payrollTotal, payrollPending, payablesPending]) t.total = t.q1 + t.q2;
  const payrollLines = payroll.map((r) => {
    total.q1 += r.q1.expected;
    total.q2 += r.q2.expected;
    paid.q1 += Math.min(r.q1.paid ?? 0, r.q1.expected);
    paid.q2 += Math.min(r.q2.paid ?? 0, r.q2.expected);
    return {
      _id: r._id,
      name: r.name,
      position: r.position,
      q1: r.q1.expected,
      q2: r.q2.expected,
      total: r.q1.expected + r.q2.expected,
      q1Status: r.q1.status,
      q2Status: r.q2.status,
      paid: (r.q1.paid ?? 0) + (r.q2.paid ?? 0),
    };
  });
  const payableLines = payables.map((p) => {
    if (p.fortnight === 1) total.q1 += p.amount;
    else total.q2 += p.amount;
    const paidPart = Math.min(p.paidAmount, p.amount);
    if (p.fortnight === 1) paid.q1 += paidPart;
    else paid.q2 += paidPart;
    return {
      _id: p._id,
      beneficiary: p.beneficiary,
      category: p.category,
      q1: p.fortnight === 1 ? p.amount : 0,
      q2: p.fortnight === 2 ? p.amount : 0,
      total: p.amount,
      status: p.status,
      paidAmount: p.paidAmount,
      paidDate: p.paidDate,
      method: p.method,
      reference: p.reference,
      // Los de nómina no suman a la utilidad (el sueldo sale de Nómina).
      countsInProfit: p.category !== "nomina",
    };
  });
  total.total = total.q1 + total.q2;
  paid.total = paid.q1 + paid.q2;
  return {
    payroll: payrollLines,
    payables: payableLines,
    total,
    paid,
    pending: { q1: total.q1 - paid.q1, q2: total.q2 - paid.q2, total: total.total - paid.total },
    payrollTotal,
    payrollPending,
    payablesPending,
  };
}

const sub = (a: QTotals, b: QTotals): QTotals => ({
  q1: a.q1 - b.q1,
  q2: a.q2 - b.q2,
  total: a.total - b.total,
});
const add = (...xs: QTotals[]): QTotals =>
  xs.reduce((s, x) => ({ q1: s.q1 + x.q1, q2: s.q2 + x.q2, total: s.total + x.total }), qZero());
const ratio = (a: QTotals, b: QTotals) => ({
  q1: b.q1 ? a.q1 / b.q1 : 0,
  q2: b.q2 ? a.q2 / b.q2 : 0,
  total: b.total ? a.total / b.total : 0,
});

export async function fortnightReport(user: SessionUser, query: any) {
  const month = monthParam(query?.month);
  const scope = branchFilter(user, query?.branch);
  const { from, to } = monthBounds(month);
  const [rec, cobrado, gastos, pagos] = await Promise.all([
    reconciliation(scope, from, to),
    collected(scope, from, to),
    expensesOf(scope, from, to),
    toPay(scope, month),
  ]);
  const cashAvailable = sub(rec.cashCollected, gastos.cashOut);
  const pendingCollection = add(rec.toConfirm, rec.toCollect);
  // Las propinas cobradas con el pago entraron a cuenta pero no son producción: se restan.
  const accounted = add(rec.received, cashAvailable, gastos.cashOut, pendingCollection, rec.barter, rec.lost);
  const difference = sub(sub(accounted, rec.production), rec.tips);
  const totalCosts = add(gastos.total, pagos.payrollTotal, pagos.payablesPending);
  const profit = sub(rec.production, totalCosts);
  const pendingPayments = add(pagos.payrollPending, pagos.payablesPending);

  return {
    month,
    fortnights: { q1: { from, to: `${month}-15` }, q2: { from: `${month}-16`, to } },
    bookings: rec.bookings,
    reconciliation: {
      production: qRound(rec.production),
      received: qRound(rec.received),
      receivedByAccount: rec.receivedByAccount,
      productionByAccount: rec.productionByAccount,
      cashCollected: qRound(rec.cashCollected),
      cashAvailable: qRound(cashAvailable),
      cashDisbursed: qRound(gastos.cashOut),
      toConfirm: qRound(rec.toConfirm),
      toCollect: qRound(rec.toCollect),
      pendingCollection: qRound(pendingCollection),
      barter: qRound(rec.barter),
      lost: qRound(rec.lost),
      tips: qRound(rec.tips),
      difference: qRound(difference),
    },
    collected: cobrado,
    expenses: { byCategory: gastos.byCategory, total: gastos.total },
    toPay: pagos,
    profit: {
      expenses: gastos.total,
      payroll: pagos.payrollTotal,
      payablesPending: pagos.payablesPending,
      totalCosts: qRound(totalCosts),
      profit: qRound(profit),
      margin: ratio(profit, rec.production),
    },
    liquidity: {
      inAccounts: qRound(rec.received),
      pendingPayments,
      available: qRound(sub(rec.received, pendingPayments)),
    },
  };
}
