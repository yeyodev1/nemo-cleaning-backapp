import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { User } from "../models/user.model";
import { serializeUser } from "./user.service";

const TOKEN_TTL = "30d";

function signToken(user: any): string {
  return jwt.sign({ userId: String(user._id), role: user.role }, env.JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

export async function login(emailRaw: unknown, passwordRaw: unknown) {
  const email = String(emailRaw ?? "")
    .toLowerCase()
    .trim();
  const password = String(passwordRaw ?? "");
  if (!email || !password) throw new CustomError("Escribe tu correo y tu contraseña", 400);

  const user = await User.findOne({ email }).select("+password");
  // Mismo mensaje exista o no la cuenta: el login no sirve para descubrir correos.
  const invalid = new CustomError("Correo o contraseña incorrectos", 401);
  if (!user || !user.active) throw invalid;
  if (!(await bcrypt.compare(password, user.password))) throw invalid;

  user.lastLoginAt = new Date();
  await user.save();
  return { token: signToken(user), user: serializeUser(user) };
}

export async function me(id: string) {
  const user = await User.findById(id);
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  return serializeUser(user);
}

export async function changePassword(id: string, currentRaw: unknown, nextRaw: unknown) {
  const current = String(currentRaw ?? "");
  const next = String(nextRaw ?? "");
  if (next.length < 8)
    throw new CustomError("La nueva contraseña debe tener al menos 8 caracteres", 400);
  const user = await User.findById(id).select("+password");
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  if (!(await bcrypt.compare(current, user.password))) {
    throw new CustomError("La contraseña actual no es correcta", 401);
  }
  user.password = next;
  await user.save();
  return serializeUser(user);
}

/**
 * Crea la cuenta de gerencia si todavía no existe. Las credenciales salen del
 * entorno; si la cuenta ya está no se toca, para no pisar una contraseña
 * cambiada desde el panel.
 */
export async function seedAdmin(): Promise<void> {
  if (!isConnected()) return;
  if (!env.ADMIN_PASSWORD) {
    console.warn("[auth] ADMIN_PASSWORD no definida — no se crea la cuenta de administración");
    return;
  }
  try {
    if (await User.exists({ email: env.ADMIN_EMAIL })) return;
    const branches = await Branch.find().select("_id").lean();
    await User.create({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      name: env.ADMIN_NAME,
      role: "admin",
      branches: branches.map((b) => b._id),
      color: "#0B4F8A",
    });
    console.log(`[auth] cuenta de administración creada: ${env.ADMIN_EMAIL}`);
  } catch (error) {
    console.error("[auth] no se pudo crear la cuenta de administración:", error);
  }
}
