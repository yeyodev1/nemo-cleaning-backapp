import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Customer } from "../models/customer.model";
import { CUSTOMER_AUDIENCE } from "../types/AuthRequest";
import { requireEmail } from "../utils/http";
import { serializeCustomer } from "./customerAccount.service";
import { consumeLoginCode, issueLoginCode } from "./loginCode.service";

const TOKEN_TTL = "30d";

function signCustomerToken(customerId: string): string {
  return jwt.sign({ customerId, type: "customer" }, env.JWT_SECRET, {
    expiresIn: TOKEN_TTL,
    audience: CUSTOMER_AUDIENCE,
  });
}

/**
 * POST /customer-auth/request-code. Cualquier correo válido recibe código:
 * entrar y recuperar el acceso es el mismo flujo, y la cuenta se crea al
 * verificar. Respuesta idéntica siempre.
 */
export async function requestCode(emailRaw: unknown) {
  const email = requireEmail(emailRaw);
  await issueLoginCode(email, "customer", { deliver: true });
  return { ok: true };
}

/**
 * POST /customer-auth/verify. Usa el Customer que ya existe con ese correo
 * (los pedidos hechos como invitado quedan vinculados) o crea uno.
 */
export async function verifyCode(emailRaw: unknown, codeRaw: unknown) {
  const email = requireEmail(emailRaw);
  await consumeLoginCode(email, "customer", codeRaw);
  // Upsert atómico; si hubiera duplicados históricos se toma el más antiguo.
  const customer = await Customer.findOneAndUpdate(
    { email },
    { $setOnInsert: { email, name: "" } },
    { upsert: true, new: true, sort: { createdAt: 1 } },
  ).lean();
  return { token: signCustomerToken(String(customer!._id)), customer: serializeCustomer(customer) };
}
