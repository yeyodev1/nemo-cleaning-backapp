import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models/user.model";
import { AuthRequest, CUSTOMER_AUDIENCE, JwtPayload, Role } from "../types/AuthRequest";

/**
 * Además de la firma, consulta la cuenta en cada petición: un token vive 30 días
 * y desactivar a alguien o cambiarle el rol o las sucursales tiene que surtir
 * efecto ya, no cuando el token venza.
 */
export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ message: "Inicia sesión para continuar" });
    return;
  }

  let decoded: Omit<JwtPayload, "type"> & { aud?: string | string[]; type?: string };
  try {
    decoded = jwt.verify(authHeader.slice(7), env.JWT_SECRET) as typeof decoded;
  } catch {
    res.status(401).json({ message: "Tu sesión venció. Inicia sesión de nuevo" });
    return;
  }
  // Un token de cliente está firmado con el mismo secreto: no abre el panel.
  const aud = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
  if (decoded.type === "customer" || aud.includes(CUSTOMER_AUDIENCE) || !decoded.userId) {
    res.status(401).json({ message: "Inicia sesión con tu cuenta del personal" });
    return;
  }

  const user = await User.findById(decoded.userId)
    .select("email name role branches active")
    .lean<any>();
  if (!user || !user.active) {
    res.status(401).json({ message: "Tu cuenta no está activa. Inicia sesión de nuevo" });
    return;
  }
  req.user = {
    id: String(user._id),
    email: user.email,
    name: user.name ?? "",
    role: user.role,
    branches: (user.branches ?? []).map(String),
  };
  next();
}

/** Gate de rol. Va siempre después de authMiddleware. */
export function requireRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: "No tienes permiso para hacer esto" });
      return;
    }
    next();
  };
}
