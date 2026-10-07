import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { HALF_DAY_UNTIL, SHIFT_STATUSES, Shift, ShiftStatus } from "../models/shift.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { currentMonth, daysBetween, isValidDate, isValidMonth, monthBounds, weekDayOf } from "../utils/date";
import { actor, branchFilter } from "../utils/scope";

/**
 * Turnos (hoja "Calendario"): ACTIVO / LIBRE / MEDIO DÍA por operador y día.
 * Sin registro = ACTIVO, así la agenda sigue funcionando aunque no se llene el mes.
 */

function scopeOperators(user: SessionUser, branch: unknown) {
  const scope = branchFilter(user, branch);
  return { role: "operator", active: true, ...(scope.branch ? { branches: scope.branch } : {}) };
}

/** GET /admin/shifts?month=&branch= */
export async function monthShifts(user: SessionUser, query: any) {
  const month = query?.month ? String(query.month) : currentMonth();
  if (!isValidMonth(month)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  const { from, to } = monthBounds(month);
  const operators = await User.find(scopeOperators(user, query?.branch))
    .select("name color branches position")
    .sort({ name: 1 })
    .lean();
  const shifts = await Shift.find({
    operator: { $in: operators.map((o) => o._id) },
    date: { $gte: from, $lte: to },
  }).lean();
  const cells: Record<string, Record<string, ShiftStatus>> = {};
  for (const s of shifts) {
    const op = String(s.operator);
    (cells[op] ??= {})[s.date] = s.status;
  }
  return {
    month,
    days: daysBetween(from, to).map((date) => ({ date, weekday: weekDayOf(date) })),
    operators: operators.map((o) => ({
      _id: String(o._id),
      name: o.name,
      color: o.color,
      position: o.position ?? "",
      branches: (o.branches ?? []).map(String),
    })),
    cells,
  };
}

/** PUT /admin/shifts — body `{ changes: [{ operator, date, status }] }` (un clic o un mes entero). */
export async function saveShifts(user: SessionUser, body: any) {
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  if (!changes.length) throw new CustomError("No hay cambios para guardar", 400);
  if (changes.length > 1000) throw new CustomError("Demasiados cambios a la vez", 400);
  const allowed = await User.find(scopeOperators(user, undefined)).select("_id").lean();
  const allowedIds = new Set(allowed.map((u) => String(u._id)));
  const by = actor(user);
  const ops = changes.map((c: any) => {
    const operator = String(c?.operator ?? "");
    if (!isValidObjectId(operator) || !allowedIds.has(operator))
      throw new CustomError("Operador inválido o fuera de tu sucursal", 400);
    if (!isValidDate(c?.date)) throw new CustomError("Fecha inválida en los turnos", 400);
    if (!(SHIFT_STATUSES as readonly string[]).includes(String(c?.status)))
      throw new CustomError("Estado de turno inválido", 400);
    return {
      updateOne: {
        filter: { operator: new Types.ObjectId(operator), date: c.date },
        update: { $set: { status: c.status, updatedBy: by } },
        upsert: true,
      },
    };
  });
  await Shift.bulkWrite(ops);
  return { ok: true, saved: ops.length };
}

/**
 * Capacidad de un turno según el calendario: operadores ACTIVOS ese día, más los de
 * MEDIO DÍA si el turno empieza antes de las 13:00. Sin operadores cargados = 1 (como antes).
 */
export async function capacityFor(branchId: Types.ObjectId | string, date: string) {
  const operators = await User.find({ role: "operator", active: true, branches: branchId }).select("_id").lean();
  if (!operators.length) return () => 1;
  const shifts = await Shift.find({ operator: { $in: operators.map((o) => o._id) }, date }).select("status").lean();
  const off = shifts.filter((s) => s.status === "off").length;
  const half = shifts.filter((s) => s.status === "half").length;
  const full = operators.length - off - half;
  return (time: string) => full + (time < HALF_DAY_UNTIL ? half : 0);
}
