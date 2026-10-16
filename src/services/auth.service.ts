import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { User } from "../models/user.model";
import { STAFF_AUDIENCE } from "../types/AuthRequest";
import { requireEmail } from "../utils/http";
import { verifyPassword } from "../utils/password";
import { consumeLoginCode, issueLoginCode } from "./loginCode.service";
import { serializeUser } from "./user.service";

const TOKEN_TTL = "30d";

function signToken(user: any): string {
  return jwt.sign({ userId: String(user._id), role: user.role, type: "staff" }, env.JWT_SECRET, {
    expiresIn: TOKEN_TTL,
    audience: STAFF_AUDIENCE,
  });
}

/**
 * POST /auth/request-code. Solo las cuentas activas reciben código, pero la
 * respuesta es la misma siempre: el login no sirve para descubrir correos.
 */
export async function requestCode(emailRaw: unknown) {
  const email = requireEmail(emailRaw);
  const user = await User.findOne({ email }).select("active").lean();
  await issueLoginCode(email, "staff", { deliver: Boolean(user?.active) });
  return { ok: true };
}

export async function verifyCode(emailRaw: unknown, codeRaw: unknown) {
  const email = requireEmail(emailRaw);
  await consumeLoginCode(email, "staff", codeRaw);
  const user = await User.findOne({ email });
  // La cuenta pudo desactivarse entre el envío y la verificación.
  if (!user || !user.active) throw new CustomError("Tu cuenta no está activa", 401);
  user.lastLoginAt = new Date();
  await user.save();
  return { token: signToken(user), user: serializeUser(user) };
}

/** POST /auth/login. Mismo mensaje si el correo no existe o la clave falla. */
export async function loginWithPassword(emailRaw: unknown, passwordRaw: unknown) {
  const email = requireEmail(emailRaw);
  const password = String(passwordRaw ?? "");
  if (!password) throw new CustomError("Escribe tu contraseña", 400);
  const user = await User.findOne({ email }).select("+password");
  if (!user || !verifyPassword(password, user.password)) {
    throw new CustomError("Correo o contraseña incorrectos", 401);
  }
  if (!user.active) throw new CustomError("Tu cuenta no está activa", 401);
  user.lastLoginAt = new Date();
  await user.save();
  return { token: signToken(user), user: serializeUser(user) };
}

export async function me(id: string) {
  const user = await User.findById(id);
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  return serializeUser(user);
}

/**
 * Crea la cuenta de gerencia desde ADMIN_EMAIL si todavía no existe. Ya no
 * necesita contraseña: entra con un código al correo.
 */
export async function seedAdmin(): Promise<void> {
  if (!isConnected()) return;
  try {
    if (await User.exists({ email: env.ADMIN_EMAIL })) return;
    const branches = await Branch.find().select("_id").lean();
    await User.create({
      email: env.ADMIN_EMAIL,
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
