import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { SessionUser } from "../types/AuthRequest";
import { todayStr } from "../utils/date";
import { RECEIVABLE_MATCH } from "../utils/paymentAccount";
import { Payment } from "../models/payment.model";
import { branchFilter } from "../utils/scope";

/**
 * Cuentas por cobrar con antigüedad (hojas "CXC" y "Hoja 7" del Excel): pedidos ya
 * realizados (fecha ≤ hoy, no cancelados) con saldo. Rangos por días calendario desde la
 * fecha del servicio: 5 días o menos, 6–30, 31–60, más de 60. Plan mensual, canje y cortesía
 * no dejan deuda; las transferencias en revisión van como "Por confirmar" y las perdidas se
 * muestran aparte (ninguna suma a lo que se espera cobrar).
 */

export const AGING_BUCKETS = ["d0_5", "d6_30", "d31_60", "d60"] as const;
type Bucket = (typeof AGING_BUCKETS)[number];

function daysSince(date: string, today: string): number {
  const a = new Date(`${date}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86400000));
}

function bucketOf(days: number): Bucket {
  if (days <= 5) return "d0_5";
  if (days <= 30) return "d6_30";
  if (days <= 60) return "d31_60";
  return "d60";
}

export async function receivablesAging(user: SessionUser, query: any) {
  const today = todayStr();
  const scope = branchFilter(user, query?.branch);
  const done = { ...scope, date: { $lte: today }, status: { $nin: INACTIVE_STATUSES } };
  const [bookings, lostAgg, reviewAgg] = await Promise.all([
    Booking.find({ ...done, ...RECEIVABLE_MATCH })
      .populate("customer", "name phone email")
      .sort({ date: 1 })
      .lean(),
    Booking.aggregate<{ total: number; count: number }>([
      { $match: { ...done, balance: { $gt: 0 }, paymentConfirmation: "lost" } },
      { $group: { _id: null, total: { $sum: "$balance" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate<{ total: number; count: number }>([
      { $match: { ...scope, status: "review" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const buckets: Record<Bucket, number> = { d0_5: 0, d6_30: 0, d31_60: 0, d60: 0 };
  const customers = new Map<string, any>();
  for (const b of bookings) {
    const days = daysSince(b.date, today);
    const bucket = bucketOf(days);
    buckets[bucket] += b.balance;
    const c: any = b.customer ?? {};
    const key = String(c._id ?? "sin-cliente");
    const row = customers.get(key) ?? {
      customer: { _id: c._id ?? null, name: c.name || "Sin nombre", phone: c.phone ?? "", email: c.email ?? "" },
      total: 0,
      oldestDays: 0,
      bucket: "d0_5" as Bucket,
      bookings: [] as any[],
    };
    row.total += b.balance;
    if (days >= row.oldestDays) {
      row.oldestDays = days;
      row.bucket = bucket;
    }
    row.bookings.push({
      _id: b._id,
      code: b.code,
      date: b.date,
      total: b.total,
      amountPaid: b.amountPaid,
      balance: b.balance,
      paymentStatus: b.paymentStatus,
      days,
      bucket,
    });
    customers.set(key, row);
  }
  const items = [...customers.values()].sort((a, b) => b.oldestDays - a.oldestDays || b.total - a.total);
  return {
    today,
    total: items.reduce((s, r) => s + r.total, 0),
    customers: items.length,
    bookings: items.reduce((s, r) => s + r.bookings.length, 0),
    buckets,
    lost: { total: lostAgg[0]?.total ?? 0, count: lostAgg[0]?.count ?? 0 },
    toConfirm: { total: reviewAgg[0]?.total ?? 0, count: reviewAgg[0]?.count ?? 0 },
    items,
  };
}
