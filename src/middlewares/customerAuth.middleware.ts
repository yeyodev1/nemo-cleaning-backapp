import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Customer } from "../models/customer.model";
import {
  CUSTOMER_AUDIENCE,
  CustomerJwtPayload,
  CustomerRequest,
  SessionCustomer,
} from "../types/AuthRequest";

/** Decodifica un token de cliente; null si falta, venció o es de otro tipo (personal). */
async function resolveCustomer(header: string | undefined): Promise<SessionCustomer | null> {
  if (!header || !header.startsWith("Bearer ")) return null;
  let decoded: CustomerJwtPayload;
  try {
    decoded = jwt.verify(header.slice(7), env.JWT_SECRET, {
      audience: CUSTOMER_AUDIENCE,
    }) as CustomerJwtPayload;
  } catch {
    return null;
  }
  if (decoded.type !== "customer" || !decoded.customerId) return null;
  const customer = await Customer.findById(decoded.customerId).select("email").lean<any>();
  if (!customer) return null;
  return { id: String(customer._id), email: customer.email ?? "" };
}

/** Rutas de "Mi cuenta": exigen token de cliente (el del personal no sirve). */
export async function customerAuthMiddleware(
  req: CustomerRequest,
  res: Response,
  next: NextFunction,
) {
  const customer = await resolveCustomer(req.headers.authorization);
  if (!customer) {
    res.status(401).json({ message: "Inicia sesión con tu correo para continuar" });
    return;
  }
  req.customer = customer;
  next();
}

/**
 * Para la reserva pública: si viene un token de cliente válido, el pedido se
 * asocia a esa cuenta; si no, sigue como invitado (se busca por correo).
 */
export async function optionalCustomerAuth(
  req: CustomerRequest,
  _res: Response,
  next: NextFunction,
) {
  const customer = await resolveCustomer(req.headers.authorization);
  if (customer) req.customer = customer;
  next();
}
