import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { STAFF_INCIDENT_TYPES, StaffIncident, StaffIncidentType } from "../models/staffIncident.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { addDays, isValidDate, todayStr } from "../utils/date";
import { assertObjectId, str } from "../utils/http";
import { actor } from "../utils/scope";

/**
 * Novedades del personal: llegó tarde, faltó, pelea, problema con un cliente, daño.
 * Gerencia ve y registra de todos; el administrador de sucursal, solo de su gente.
 */

/** El administrador (manager) solo toca a personas de sus sucursales (y nunca a gerencia). */
async function assertPersonAccess(user: SessionUser, personId: string) {
  const person = await User.findById(assertObjectId(personId, "la persona")).select("name role branches").lean();
  if (!person) throw new CustomError("Persona no encontrada", 404);
  if (user.role === "admin") return person;
  const shares = (person.branches ?? []).some((b) => user.branches.includes(String(b)));
  if (person.role === "admin" || !shares) throw new CustomError("No tienes acceso a esta persona", 403);
  return person;
}

function serialize(i: any) {
  return {
    _id: String(i._id),
    user: i.user?._id ? { _id: String(i.user._id), name: i.user.name, color: i.user.color } : null,
    branch: i.branch ? String(i.branch) : null,
    type: i.type,
    date: i.date,
    text: i.text ?? "",
    by: i.by ?? null,
    createdAt: i.createdAt,
  };
}

/** GET /admin/staff-incidents?user=&from=&to= — por defecto los últimos 30 días. */
export async function listStaffIncidents(user: SessionUser, query: any) {
  const to = isValidDate(query?.to) ? query.to : todayStr();
  const from = isValidDate(query?.from) ? query.from : addDays(to, -30);
  const filter: Record<string, any> = { date: { $gte: from, $lte: to } };
  if (query?.user) {
    await assertPersonAccess(user, String(query.user));
    filter.user = new Types.ObjectId(String(query.user));
    // En el perfil se ve todo el historial de la persona, no solo 30 días.
    if (!query?.from) delete filter.date;
  } else if (user.role !== "admin") {
    const branches = user.branches.map((b) => new Types.ObjectId(b));
    const people = await User.find({ branches: { $in: branches }, role: { $ne: "admin" } })
      .select("_id")
      .lean();
    // Las de su gente y las generales de sus sucursales.
    filter.$or = [{ user: { $in: people.map((p) => p._id) } }, { user: null, branch: { $in: branches } }];
  }
  if (query?.general === "1") filter.user = null;
  if (query?.type && (STAFF_INCIDENT_TYPES as readonly string[]).includes(String(query.type))) filter.type = String(query.type);
  const items = await StaffIncident.find(filter).sort({ date: -1, createdAt: -1 }).limit(500).populate("user", "name color").lean();
  return { from, to, items: items.map(serialize), total: items.length };
}

/** POST /admin/staff-incidents — { user?, branch?, type, date, text }. Sin `user` = general. */
export async function createStaffIncident(user: SessionUser, body: any) {
  const personId = body?.user ? String(body.user) : "";
  let branch: string | null = null;
  if (personId) {
    if (!isValidObjectId(personId)) throw new CustomError("Elige a la persona", 400);
    await assertPersonAccess(user, personId);
  } else {
    branch = body?.branch && isValidObjectId(String(body.branch)) ? String(body.branch) : user.role === "admin" ? null : user.branches[0] ?? null;
    if (branch && user.role !== "admin" && !user.branches.includes(branch)) throw new CustomError("No tienes acceso a esta sucursal", 403);
  }
  const type = String(body?.type ?? "") as StaffIncidentType;
  if (!(STAFF_INCIDENT_TYPES as readonly string[]).includes(type)) throw new CustomError("Elige qué pasó", 400);
  const date = isValidDate(body?.date) ? body.date : todayStr();
  if (date > todayStr()) throw new CustomError("La fecha no puede ser futura", 400);
  const text = str(body?.text, 1000);
  if ((type === "other" || !personId) && !text) throw new CustomError("Describe qué pasó", 400);
  const created = await StaffIncident.create({ user: personId || null, branch, type, date, text, by: actor(user) });
  return serialize(await StaffIncident.findById(created._id).populate("user", "name color").lean());
}

/** DELETE /admin/staff-incidents/:id — gerencia, o quien la registró. */
export async function deleteStaffIncident(user: SessionUser, id: string) {
  const item = await StaffIncident.findById(assertObjectId(id, "la novedad"));
  if (!item) throw new CustomError("Novedad no encontrada", 404);
  if (user.role !== "admin" && item.by?.id !== user.id) throw new CustomError("Solo gerencia o quien la registró puede borrarla", 403);
  await item.deleteOne();
  return { ok: true };
}
