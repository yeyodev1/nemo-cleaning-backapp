import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { SessionUser } from "../types/AuthRequest";
import { assertObjectId, isValidTimeOrThrow, slugify, str } from "../utils/branchHelpers";

export async function listPublicBranches() {
  return Branch.find({ active: true }).sort({ name: 1 }).lean();
}

export async function listBranches(user: SessionUser) {
  const filter =
    user.role === "admin" ? {} : { _id: { $in: user.branches.map((b) => new Types.ObjectId(b)) } };
  return Branch.find(filter).sort({ name: 1 }).lean();
}

export async function getBranch(id: string) {
  assertObjectId(id, "la sucursal");
  const b = await Branch.findById(id).lean();
  if (!b) throw new CustomError("Sucursal no encontrada", 404);
  return b;
}

function applyFields(target: any, body: any) {
  for (const key of ["address", "phone", "whatsapp", "email"] as const) {
    if (body?.[key] !== undefined) target[key] = str(body[key], 200);
  }
  if (body?.name !== undefined) target.name = str(body.name, 80);
  if (body?.active !== undefined) target.active = Boolean(body.active);
  if (body?.openingTime !== undefined)
    target.openingTime = isValidTimeOrThrow(body.openingTime, "openingTime");
  if (body?.closingTime !== undefined)
    target.closingTime = isValidTimeOrThrow(body.closingTime, "closingTime");
  if (body?.slotMinutes !== undefined) {
    const n = Number(body.slotMinutes);
    if (!Number.isInteger(n) || n < 15 || n > 480)
      throw new CustomError("slotMinutes debe estar entre 15 y 480", 400);
    target.slotMinutes = n;
  }
  if (body?.workDays !== undefined) {
    if (!Array.isArray(body.workDays))
      throw new CustomError("workDays debe ser una lista de 0 a 6", 400);
    const days = [...new Set(body.workDays.map(Number))] as number[];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new CustomError("workDays debe ser una lista de 0 (domingo) a 6 (sábado)", 400);
    }
    target.workDays = days.sort();
  }
}

function assertHours(b: any) {
  if (b.openingTime >= b.closingTime)
    throw new CustomError("La hora de apertura debe ser antes del cierre", 400);
}

export async function createBranch(body: any) {
  const name = str(body?.name, 80);
  if (!name) throw new CustomError("El nombre es obligatorio", 400);
  const data: any = { name, slug: slugify(str(body?.slug, 80) || name) };
  applyFields(data, body);
  assertHours({
    openingTime: data.openingTime ?? "08:00",
    closingTime: data.closingTime ?? "18:00",
  });
  return (await Branch.create(data)).toObject();
}

export async function updateBranch(id: string, body: any) {
  assertObjectId(id, "la sucursal");
  const branch = await Branch.findById(id);
  if (!branch) throw new CustomError("Sucursal no encontrada", 404);
  applyFields(branch, body);
  if (body?.slug !== undefined) branch.slug = slugify(str(body.slug, 80)) || branch.slug;
  assertHours(branch);
  await branch.save();
  return branch.toObject();
}
