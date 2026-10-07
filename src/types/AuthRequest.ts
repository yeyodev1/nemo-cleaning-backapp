import { Request } from "express";

export type Role = "admin" | "manager" | "operator";

/**
 * Token del personal. Los emitidos antes del acceso por código no traen `type`;
 * se aceptan igual mientras no sean de cliente.
 */
export interface JwtPayload {
  userId: string;
  role: Role;
  type?: "staff";
}

/** Token del cliente: audiencia y tipo propios para que no abra el panel. */
export interface CustomerJwtPayload {
  customerId: string;
  type: "customer";
}

export const CUSTOMER_AUDIENCE = "customer";
export const STAFF_AUDIENCE = "staff";

/** Lo que authMiddleware deja en req.user, leído de la base (no del token). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  branches: string[];
}

export interface SessionCustomer {
  id: string;
  email: string;
}

export interface AuthRequest extends Request {
  user?: SessionUser;
}

export interface CustomerRequest extends Request {
  customer?: SessionCustomer;
}
