import { Request } from "express";

export type Role = "admin" | "manager" | "operator";

export interface JwtPayload {
  userId: string;
  role: Role;
}

/** Lo que authMiddleware deja en req.user, leído de la base (no del token). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  branches: string[];
}

export interface AuthRequest extends Request {
  user?: SessionUser;
}
