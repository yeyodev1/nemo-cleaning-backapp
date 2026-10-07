import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { Branch } from "../models/branch.model";
import { Customer } from "../models/customer.model";
import { paginated, parsePage, str } from "../utils/http";
import { trackingUrl } from "./bookingEmail.service";

const DOCUMENT_RE = /^\d{10}(\d{3})?$/;

/** Lo que ve el propio cliente de su ficha: sin notas internas ni totales del negocio. */
export function serializeCustomer(c: any) {
  return {
    _id: String(c._id),
    name: c.name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    documentId: c.documentId ?? "",
    address: c.address ?? "",
    createdAt: c.createdAt,
  };
}

export async function getMe(id: string) {
  const customer = await Customer.findById(id).lean();
  if (!customer) throw new CustomError("Cliente no encontrado", 404);
  return serializeCustomer(customer);
}

/** PATCH /customer/me. El correo no se cambia aquí: es con lo que se ingresa. */
export async function updateMe(id: string, body: any) {
  const customer = await Customer.findById(id);
  if (!customer) throw new CustomError("Cliente no encontrado", 404);
  if (body?.name !== undefined) {
    const name = str(body.name, 160);
    if (!name) throw new CustomError("Escribe tu nombre", 400);
    customer.name = name;
  }
  if (body?.phone !== undefined) {
    const phone = str(body.phone, 30);
    if (phone && phone.replace(/\D/g, "").length < 7)
      throw new CustomError("Escribe un teléfono válido", 400);
    customer.phone = phone;
  }
  if (body?.documentId !== undefined) {
    const documentId = str(body.documentId, 20).replace(/\s/g, "");
    if (documentId && !DOCUMENT_RE.test(documentId))
      throw new CustomError("La cédula debe tener 10 dígitos o el RUC 13", 400);
    customer.documentId = documentId;
  }
  if (body?.address !== undefined) customer.address = str(body.address, 300);
  await customer.save();
  return serializeCustomer(customer);
}

/**
 * GET /customer/bookings. Se emparejan por el Customer, así que también salen
 * los pedidos que hizo como invitado con el mismo correo. Cada uno trae su
 * accessToken para abrir el seguimiento.
 */
export async function listBookings(id: string, query: any) {
  const { page, limit, skip } = parsePage(query);
  const filter = { customer: new Types.ObjectId(id) };
  const [rows, total] = await Promise.all([
    Booking.find(filter)
      .select(
        "+accessToken code branch items total amountPaid balance date time status paymentMethod paymentStatus createdAt",
      )
      .sort({ startAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<any[]>(),
    Booking.countDocuments(filter),
  ]);
  const branchIds = [...new Set(rows.map((b) => String(b.branch)))];
  const branches = await Branch.find({ _id: { $in: branchIds } })
    .select("name")
    .lean();
  const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
  const items = rows.map((b) => ({
    _id: String(b._id),
    code: b.code,
    branch: String(b.branch),
    branchName: branchName.get(String(b.branch)) ?? "",
    items: (b.items ?? []).map((i: any) => ({ name: i.name, quantity: i.quantity })),
    total: b.total,
    amountPaid: b.amountPaid,
    balance: b.balance,
    date: b.date,
    time: b.time,
    status: b.status,
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    accessToken: b.accessToken,
    trackingUrl: trackingUrl(b.code, b.accessToken),
    createdAt: b.createdAt,
  }));
  return paginated(items, total, page, limit);
}
