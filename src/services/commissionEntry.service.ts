import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { CommissionEntry } from "../models/commissionEntry.model";
import { User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { isValidMonth } from "../utils/date";
import { yearParam } from "../utils/fortnight";
import { assertObjectId, str } from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";
import { staffPosition } from "./payroll.service";

/**
 * Comisiones manuales (hoja "Comisiones" del Excel): gerencia escribe el monto de cada
 * colaborador en cada mes. Celda vacía = sin registro. Estas cifras son las que usan los
 * reportes; el FEE calculado (`commission.service.ts`) es solo una referencia.
 */

const monthsOf = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

/** Nombre libre normalizado: "  Juan  " y "juan" son la misma fila. */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Personal activo del alcance, para "Agregar colaborador" (cualquiera, no solo lavadores). */
export async function staffOptions(scope: Record<string, any>) {
  const filter: Record<string, any> = { active: true };
  if (scope.branch) filter.branches = scope.branch.$in ? { $in: scope.branch.$in } : scope.branch;
  const users = await User.find(filter).select("name position role branches").sort({ name: 1 }).lean();
  return users.map((u) => ({
    _id: String(u._id),
    name: u.name,
    position: staffPosition(u),
    branches: (u.branches ?? []).map(String),
  }));
}

export async function branchNames() {
  const branches = await Branch.find().select("name").lean();
  return new Map(branches.map((b) => [String(b._id), b.name]));
}

/** GET /admin/commissions/entries?year=&branch= — la grilla del año (filas × ENE…DIC). */
export async function yearGrid(user: SessionUser, query: any) {
  const year = yearParam(query?.year);
  const scope = branchFilter(user, query?.branch);
  const months = monthsOf(year);
  const [entries, names, staff] = await Promise.all([
    CommissionEntry.find({ ...scope, month: { $gte: months[0], $lte: months[11] } }).lean(),
    branchNames(),
    staffOptions(scope),
  ]);
  // El nombre de una fila de Personal sigue al Personal (si lo corrigen, se corrige aquí).
  const userIds = [...new Set(entries.filter((e) => e.user).map((e) => String(e.user)))];
  const people = await User.find({ _id: { $in: userIds } }).select("name position role").lean();
  const personMap = new Map(people.map((p) => [String(p._id), p]));

  const rows = new Map<string, any>();
  for (const e of entries) {
    const key = `${String(e.branch)}|${e.rowKey}`;
    const person = e.user ? personMap.get(String(e.user)) : undefined;
    const row =
      rows.get(key) ??
      {
        key,
        branch: String(e.branch),
        branchName: names.get(String(e.branch)) ?? "",
        user: e.user ? String(e.user) : null,
        name: person?.name ?? e.name,
        position: e.position || (person ? staffPosition(person) : ""),
        months: Array<number | null>(12).fill(null),
        notes: Array<string>(12).fill(""),
        total: 0,
      };
    const i = Number(e.month.slice(5, 7)) - 1;
    row.months[i] = e.amount;
    row.notes[i] = e.note ?? "";
    row.total += e.amount;
    rows.set(key, row);
  }
  const list = [...rows.values()].sort(
    (a, b) => a.branchName.localeCompare(b.branchName, "es") || a.name.localeCompare(b.name, "es"),
  );
  const monthTotals = Array.from({ length: 12 }, (_, i) => list.reduce((s, r) => s + (r.months[i] ?? 0), 0));
  return { year, rows: list, monthTotals, total: monthTotals.reduce((s, n) => s + n, 0), staff };
}

/** Sucursal de la fila: la pedida, la primera del colaborador o la única que maneja el manager. */
async function resolveTarget(user: SessionUser, body: any) {
  let person: any = null;
  if (body?.user) {
    const id = assertObjectId(String(body.user), "el colaborador");
    person = await User.findById(id).select("name position role branches").lean();
    if (!person) throw new CustomError("Colaborador no encontrado", 404);
  }
  const name = person ? person.name : str(body?.name, 120);
  if (!name) throw new CustomError("Escribe el nombre del colaborador", 400);
  let branch = body?.branch ? assertObjectId(String(body.branch), "la sucursal") : "";
  if (!branch && person?.branches?.length) branch = String(person.branches[0]);
  if (!branch && user.role !== "admin" && user.branches.length === 1) branch = user.branches[0];
  if (!branch) throw new CustomError("Elige la sucursal de esta comisión", 400);
  assertBranchAccess(user, branch);
  const rowKey = person ? `u:${String(person._id)}` : `n:${nameKey(name)}`;
  return { person, name, branch, rowKey };
}

/**
 * PUT /admin/commissions/entries — `{ month, amount (centavos) | null, user? | name?, branch?, position?, note? }`.
 * `amount` null o "" borra la celda; 0 se guarda como 0.
 */
export async function saveEntry(user: SessionUser, body: any) {
  if (!isValidMonth(body?.month)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  const { person, name, branch, rowKey } = await resolveTarget(user, body);
  const filter = { branch: new Types.ObjectId(branch), month: body.month, rowKey };
  if (body?.amount === null || body?.amount === undefined || body?.amount === "") {
    await CommissionEntry.deleteOne(filter);
    return { ok: true, amount: null };
  }
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || Math.abs(amount) > 100_000_000)
    throw new CustomError("La comisión debe ser un valor en centavos", 400);
  const set: Record<string, unknown> = {
    amount,
    name,
    user: person ? person._id : null,
    updatedBy: actor(user),
  };
  if (body?.position !== undefined) set.position = str(body.position, 80);
  else if (person) set.position = staffPosition(person);
  if (body?.note !== undefined) set.note = str(body.note, 300);
  await CommissionEntry.updateOne(filter, { $set: set }, { upsert: true });
  return { ok: true, amount };
}

/** POST /admin/commissions/entries/remove-row — `{ year, user? | name?, branch? }`: borra la fila del año. */
export async function removeRow(user: SessionUser, body: any) {
  const year = yearParam(body?.year);
  const { branch, rowKey } = await resolveTarget(user, body);
  const months = monthsOf(year);
  const r = await CommissionEntry.deleteMany({
    branch: new Types.ObjectId(branch),
    rowKey,
    month: { $gte: months[0], $lte: months[11] },
  });
  return { ok: true, deleted: r.deletedCount };
}

/** Suma por mes de las comisiones manuales del año (centavos). */
export async function manualTotalsByMonth(year: number, branchId?: string): Promise<number[]> {
  const months = monthsOf(year);
  const match: Record<string, any> = { month: { $gte: months[0], $lte: months[11] } };
  if (branchId) match.branch = new Types.ObjectId(branchId);
  const rows = await CommissionEntry.aggregate<{ _id: string; total: number }>([
    { $match: match },
    { $group: { _id: "$month", total: { $sum: "$amount" } } },
  ]);
  const out = Array<number>(12).fill(0);
  for (const r of rows) out[Number(r._id.slice(5, 7)) - 1] = r.total;
  return out;
}
