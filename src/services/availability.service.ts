import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { Branch, IBranch } from "../models/branch.model";
import { User } from "../models/user.model";
import { isValidDate, minutesOf, timeOf, toDateTime, weekDayOf } from "../utils/date";
import { assertObjectId } from "../utils/http";
import { getSettings } from "./settings.service";
import { capacityFor } from "./shift.service";

export interface Slot {
  time: string;
  available: boolean;
}

/** Capacidad = lavadores activos de la sucursal (mínimo 1, para que se pueda agendar sin personal cargado). */
export async function branchCapacity(branchId: Types.ObjectId | string): Promise<number> {
  const count = await User.countDocuments({ role: "operator", active: true, branches: branchId });
  return Math.max(1, count);
}

export function slotTimes(branch: IBranch): string[] {
  // Horas fijas configuradas (8:00, 9:30, 11:00…): mandan sobre la grilla automática.
  if (branch.slotTimes?.length) return [...branch.slotTimes].sort();
  const open = minutesOf(branch.openingTime || "08:00");
  const close = minutesOf(branch.closingTime || "18:00");
  const step = branch.slotMinutes || 60;
  const out: string[] = [];
  for (let t = open; t + step <= close; t += step) out.push(timeOf(t));
  return out;
}

/**
 * Turnos del día. Un turno se ocupa cuando los pedidos activos que se cruzan con
 * él (según su duración) igualan la capacidad de la sucursal; también se cierra
 * si ya pasó o cae dentro de la anticipación mínima (bookingLeadHours).
 */
export async function computeSlots(
  branch: IBranch,
  date: string,
  { excludeBookingId }: { excludeBookingId?: string } = {},
): Promise<Slot[]> {
  if (!branch.active || !(branch.workDays ?? []).includes(weekDayOf(date))) return [];
  const times = slotTimes(branch);
  if (!times.length) return [];

  const [settings, capacity, bookings] = await Promise.all([
    getSettings(),
    // Turnos del calendario: ACTIVOS ese día (+ MEDIO DÍA en turnos de la mañana).
    capacityFor(branch._id as Types.ObjectId, date),
    Booking.find({
      branch: branch._id,
      date,
      status: { $nin: INACTIVE_STATUSES },
      ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
    })
      .select("time durationMinutes")
      .lean(),
  ]);

  const minStart = Date.now() + (settings.bookingLeadHours ?? 0) * 60 * 60 * 1000;
  const step = branch.slotMinutes || 60;
  const ranges = bookings.map((b) => {
    const start = minutesOf(b.time);
    return { start, end: start + Math.max(b.durationMinutes || step, 1) };
  });

  return times.map((time) => {
    const start = minutesOf(time);
    const end = start + step;
    const overlapping = ranges.filter((r) => r.start < end && r.end > start).length;
    const tooSoon = toDateTime(date, time).getTime() < minStart;
    return { time, available: !tooSoon && overlapping < capacity(time) };
  });
}

export async function getAvailability(branchId: unknown, date: unknown) {
  const id = assertObjectId(branchId, "la sucursal");
  if (!isValidDate(date)) throw new CustomError("La fecha debe tener el formato YYYY-MM-DD", 400);
  const branch = await Branch.findById(id);
  if (!branch || !branch.active) throw new CustomError("Sucursal no encontrada", 404);
  return { date, slots: await computeSlots(branch, date) };
}

/** Lanza 409 si el turno no existe o ya no está libre. */
export async function assertSlotAvailable(
  branch: IBranch,
  date: string,
  time: string,
  excludeBookingId?: string,
) {
  const slots = await computeSlots(branch, date, { excludeBookingId });
  const slot = slots.find((s) => s.time === time);
  if (!slot) throw new CustomError("Ese horario no está disponible en la sucursal", 409);
  if (!slot.available) throw new CustomError("Ese horario ya no está disponible. Elige otro", 409);
}
