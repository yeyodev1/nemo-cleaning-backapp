import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { Customer } from "../models/customer.model";
import { SessionUser } from "../types/AuthRequest";
import { EMAIL_RE, assertObjectId, escapeRegex, paginated, parsePage, str } from "../utils/http";
import { branchFilter } from "../utils/scope";

export async function listCustomers(query: any) {
  const { page, limit, skip } = parsePage(query);
  const filter: Record<string, any> = {};
  if (query?.q) {
    const re = new RegExp(escapeRegex(str(query.q, 80)), "i");
    filter.$or = [{ name: re }, { email: re }, { phone: re }, { documentId: re }];
  }
  if (query?.branch && isValidObjectId(String(query.branch))) filter.branch = String(query.branch);
  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Customer.countDocuments(filter),
  ]);
  return paginated(items, total, page, limit);
}

export async function getCustomer(id: string, user: SessionUser) {
  assertObjectId(id, "el cliente");
  const customer = await Customer.findById(id).lean();
  if (!customer) throw new CustomError("Cliente no encontrado", 404);
  // El manager ve el historial solo de sus sucursales.
  const bookings = await Booking.find({ customer: customer._id, ...branchFilter(user) })
    .sort({ startAt: -1 })
    .limit(100)
    .populate("operators", "name color")
    .lean();
  return { ...customer, bookings };
}

function applyFields(target: any, body: any) {
  if (body?.name !== undefined) target.name = str(body.name, 160);
  if (body?.email !== undefined) {
    const email = str(body.email, 200).toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw new CustomError("Correo inválido", 400);
    target.email = email;
  }
  if (body?.phone !== undefined) target.phone = str(body.phone, 30);
  if (body?.documentId !== undefined) target.documentId = str(body.documentId, 20);
  if (body?.address !== undefined) target.address = str(body.address, 300);
  if (body?.notes !== undefined) target.notes = str(body.notes, 2000);
  if (body?.branch !== undefined) {
    target.branch = body.branch ? assertObjectId(body.branch, "la sucursal") : null;
  }
}

export async function createCustomer(body: any) {
  const data: any = {};
  applyFields(data, body);
  if (!data.name) throw new CustomError("El nombre es obligatorio", 400);
  if (!data.email && !data.phone)
    throw new CustomError("Escribe al menos el correo o el teléfono", 400);
  if (data.email && (await Customer.exists({ email: data.email }))) {
    throw new CustomError("Ya existe un cliente con ese correo", 409);
  }
  return (await Customer.create(data)).toObject();
}

export async function updateCustomer(id: string, body: any) {
  assertObjectId(id, "el cliente");
  const customer = await Customer.findById(id);
  if (!customer) throw new CustomError("Cliente no encontrado", 404);
  applyFields(customer, body);
  if (!customer.name) throw new CustomError("El nombre es obligatorio", 400);
  await customer.save();
  return customer.toObject();
}
