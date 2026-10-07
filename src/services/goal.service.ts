import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { Goal } from "../models/goal.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { currentMonth, isValidMonth, monthBounds } from "../utils/date";
import { assertObjectId, cents, str } from "../utils/http";
import { branchFilter } from "../utils/scope";

/** Hoja "Metas Mensuales": meta por operador y mes; la producción real sale sola de los pedidos. */

function monthOf(raw: unknown): string {
  const month = raw ? String(raw) : currentMonth();
  if (!isValidMonth(month)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  return month;
}

/** GET /admin/goals?month=&branch= */
export async function monthGoals(user: SessionUser, query: any) {
  const month = monthOf(query?.month);
  const scope = branchFilter(user, query?.branch);
  const { from, to } = monthBounds(month);
  const bookings = await Booking.find({ ...scope, date: { $gte: from, $lte: to }, status: { $nin: INACTIVE_STATUSES } })
    .select("total operators")
    .lean();
  const production = new Map<string, number>();
  let company = 0;
  for (const b of bookings) {
    company += b.total;
    const share = b.operators.length ? b.total / b.operators.length : 0;
    for (const op of b.operators) production.set(String(op), (production.get(String(op)) ?? 0) + share);
  }
  const operators = await User.find({
    $or: [
      { role: "operator", active: true, ...(scope.branch ? { branches: scope.branch } : {}) },
      { _id: { $in: [...production.keys()].map((id) => new Types.ObjectId(id)) } },
    ],
  })
    .select("name color position")
    .sort({ name: 1 })
    .lean();
  const goals = await Goal.find({ month, operator: { $in: operators.map((o) => o._id) } }).lean();
  const goalMap = new Map(goals.map((g) => [String(g.operator), g]));
  const inProgress = month >= currentMonth();

  const items = operators.map((o) => {
    const id = String(o._id);
    const goal = goalMap.get(id)?.amount ?? 0;
    const prod = Math.round(production.get(id) ?? 0);
    const status = !goal ? "no_goal" : prod >= goal ? "meets" : inProgress ? "in_progress" : "misses";
    return {
      operator: id,
      name: o.name,
      color: o.color,
      position: o.position ?? "",
      goal,
      production: prod,
      compliance: goal ? prod / goal : null,
      diff: goal ? prod - goal : 0,
      status,
      notes: goalMap.get(id)?.notes ?? "",
    };
  });
  const withGoal = items.filter((i) => i.goal > 0);
  const goalTotal = withGoal.reduce((s, i) => s + i.goal, 0);
  const prodWithGoal = withGoal.reduce((s, i) => s + i.production, 0);
  return {
    month,
    inProgress,
    summary: {
      goalTotal,
      production: items.reduce((s, i) => s + i.production, 0),
      companyProduction: company,
      compliance: goalTotal ? prodWithGoal / goalTotal : null,
      meeting: withGoal.filter((i) => i.status === "meets").length,
      notMeeting: withGoal.filter((i) => i.status !== "meets").length,
      withoutGoal: items.length - withGoal.length,
    },
    items,
  };
}

/** PUT /admin/goals — `{ operator, month, amount, notes? }`; amount 0 borra la meta. */
export async function saveGoal(user: SessionUser, body: any) {
  const month = monthOf(body?.month);
  const operator = assertObjectId(String(body?.operator ?? ""), "el operador");
  const amount = cents(body?.amount ?? 0, "La meta");
  const person = await User.findById(operator).select("branches").lean();
  if (!person) throw new CustomError("Operador no encontrado", 404);
  if (user.role !== "admin" && !(person.branches ?? []).some((b) => user.branches.includes(String(b))))
    throw new CustomError("No tienes acceso a este operador", 403);
  if (!amount) {
    await Goal.deleteOne({ operator, month });
    return { ok: true };
  }
  await Goal.updateOne(
    { operator, month },
    { $set: { amount, notes: str(body?.notes, 300) } },
    { upsert: true },
  );
  return { ok: true };
}

/** POST /admin/goals/copy — `{ from: "YYYY-MM", to: "YYYY-MM" }`: repite las metas del mes anterior. */
export async function copyGoals(user: SessionUser, body: any) {
  const from = monthOf(body?.from);
  const to = monthOf(body?.to);
  if (from === to) throw new CustomError("Elige meses distintos", 400);
  const source = await Goal.find({ month: from }).lean();
  let ids = source.map((g) => g.operator);
  if (user.role !== "admin") {
    const mine = await User.find({ _id: { $in: ids }, branches: { $in: user.branches.map((b) => new Types.ObjectId(b)) } })
      .select("_id")
      .lean();
    ids = mine.map((m) => m._id as Types.ObjectId);
  }
  const allowed = new Set(ids.map(String));
  const rows = source.filter((g) => allowed.has(String(g.operator)));
  if (!rows.length) throw new CustomError("Ese mes no tiene metas para copiar", 404);
  await Goal.bulkWrite(
    rows.map((g) => ({
      updateOne: {
        filter: { operator: g.operator, month: to },
        update: { $setOnInsert: { amount: g.amount, notes: g.notes } },
        upsert: true,
      },
    })),
  );
  return { ok: true, copied: rows.length };
}
