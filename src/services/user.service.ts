import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { ROLES, User } from "../models/user.model";
import { SessionUser } from "../types/AuthRequest";
import { EMAIL_RE, assertObjectId, escapeRegex, str } from "../utils/http";

const HEX = /^#[0-9a-f]{6}$/i;

export function serializeUser(u: any) {
  return {
    _id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? "",
    role: u.role,
    branches: (u.branches ?? []).map((b: any) => String(b?._id ?? b)),
    active: u.active,
    color: u.color,
    createdAt: u.createdAt,
  };
}

async function parseBranches(raw: unknown): Promise<Types.ObjectId[]> {
  if (!Array.isArray(raw)) throw new CustomError("branches debe ser una lista de sucursales", 400);
  const ids = [...new Set(raw.map(String))];
  if (ids.some((id) => !isValidObjectId(id))) throw new CustomError("Sucursal inválida", 400);
  const count = await Branch.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) throw new CustomError("Alguna sucursal no existe", 400);
  return ids.map((id) => new Types.ObjectId(id));
}

export async function listUsers(user: SessionUser, query: any) {
  const filter: Record<string, any> = {};
  if (user.role === "manager") {
    // El manager solo necesita a los lavadores de sus sucursales para asignarlos.
    filter.role = "operator";
    filter.branches = { $in: user.branches.map((b) => new Types.ObjectId(b)) };
  } else if (query?.role && (ROLES as readonly string[]).includes(String(query.role))) {
    filter.role = String(query.role);
  }
  if (query?.branch && isValidObjectId(String(query.branch))) {
    if (user.role === "manager" && !user.branches.includes(String(query.branch))) {
      throw new CustomError("No tienes acceso a esta sucursal", 403);
    }
    filter.branches = new Types.ObjectId(String(query.branch));
  }
  if (query?.active === "true") filter.active = true;
  if (query?.active === "false") filter.active = false;
  if (query?.q) {
    const re = new RegExp(escapeRegex(str(query.q, 80)), "i");
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }
  const users = await User.find(filter).sort({ role: 1, name: 1 }).lean();
  return users.map(serializeUser);
}

export async function getUser(id: string) {
  assertObjectId(id, "el usuario");
  const u = await User.findById(id).lean();
  if (!u) throw new CustomError("Usuario no encontrado", 404);
  return serializeUser(u);
}

export async function createUser(body: any) {
  const name = str(body?.name, 120);
  const email = str(body?.email, 200).toLowerCase();
  const password = String(body?.password ?? "");
  if (!name) throw new CustomError("El nombre es obligatorio", 400);
  if (!EMAIL_RE.test(email)) throw new CustomError("Correo inválido", 400);
  if (password.length < 8)
    throw new CustomError("La contraseña debe tener al menos 8 caracteres", 400);
  const role = String(body?.role ?? "operator");
  if (!(ROLES as readonly string[]).includes(role)) throw new CustomError("Rol inválido", 400);
  const color = body?.color && HEX.test(String(body.color)) ? String(body.color) : undefined;
  const branches = body?.branches !== undefined ? await parseBranches(body.branches) : [];
  const user = await User.create({
    name,
    email,
    password,
    phone: str(body?.phone, 30),
    role,
    branches,
    active: body?.active !== false,
    ...(color ? { color } : {}),
  });
  return serializeUser(user);
}

export async function updateUser(id: string, body: any, current: SessionUser) {
  assertObjectId(id, "el usuario");
  const user = await User.findById(id).select("+password");
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  const isSelf = String(user._id) === current.id;

  if (body?.name !== undefined) user.name = str(body.name, 120) || user.name;
  if (body?.email !== undefined) {
    const email = str(body.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new CustomError("Correo inválido", 400);
    user.email = email;
  }
  if (body?.phone !== undefined) user.phone = str(body.phone, 30);
  if (body?.color !== undefined) {
    if (!HEX.test(String(body.color)))
      throw new CustomError("El color debe ser hexadecimal (#RRGGBB)", 400);
    user.color = String(body.color);
  }
  if (body?.role !== undefined) {
    if (!(ROLES as readonly string[]).includes(String(body.role)))
      throw new CustomError("Rol inválido", 400);
    if (isSelf && body.role !== "admin")
      throw new CustomError("No puedes quitarte el rol de admin", 400);
    user.role = body.role;
  }
  if (body?.branches !== undefined) user.branches = await parseBranches(body.branches);
  if (body?.active !== undefined) {
    if (isSelf && body.active === false)
      throw new CustomError("No puedes desactivar tu propia cuenta", 400);
    user.active = Boolean(body.active);
  }
  if (body?.password) {
    if (String(body.password).length < 8)
      throw new CustomError("La contraseña debe tener al menos 8 caracteres", 400);
    user.password = String(body.password);
  }
  await user.save();
  return serializeUser(user);
}
