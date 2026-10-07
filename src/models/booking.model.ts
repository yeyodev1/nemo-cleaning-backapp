import mongoose, { Schema, Document, Types } from "mongoose";

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "on_the_way",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;
export const PAYMENT_METHODS = ["card", "cash", "transfer"] as const;
export const PAYMENT_STATUSES = ["pending", "review", "partial", "paid", "refunded"] as const;
/** Estados que no ocupan agenda ni cuentan como producción. */
export const INACTIVE_STATUSES = ["cancelled", "no_show"];

export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface IBookingItem {
  service: Types.ObjectId | null;
  name: string;
  /** Opción elegida (tamaño, medida, plan…); "" si el servicio no tiene variantes. */
  variant: string;
  unitPrice: number;
  /** Tope del rango de precio (solo informativo); 0 = precio fijo. */
  unitPriceMax: number;
  /** "unidad" | "m2" | "servicio": para pintar la cantidad (m² con decimales). */
  unit: string;
  quantity: number;
  subtotal: number;
  isExtra: boolean;
}

export interface IHistory {
  at: Date;
  by: string;
  action: string;
  note: string;
}

export interface IBooking extends Document {
  code: string;
  accessToken: string;
  branch: Types.ObjectId;
  customer: Types.ObjectId;
  source: "web" | "admin";
  items: IBookingItem[];
  subtotal: number;
  discount: number;
  total: number;
  date: string;
  time: string;
  startAt: Date;
  durationMinutes: number;
  address: string;
  reference: string;
  notes: string;
  status: BookingStatus;
  operators: Types.ObjectId[];
  paymentMethod: PaymentMethod;
  paymentStatus: (typeof PAYMENT_STATUSES)[number];
  amountPaid: number;
  balance: number;
  transferProofUrl: string;
  invoice: { required: boolean; name: string; documentId: string; email: string; address: string };
  officeQuote: Types.ObjectId | null;
  history: IHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<IBookingItem>(
  {
    // null = línea libre (p. ej. una cotización de oficina convertida en pedido).
    service: { type: Schema.Types.ObjectId, ref: "Service", default: null },
    name: { type: String, required: true },
    variant: { type: String, default: "" },
    unitPrice: { type: Number, required: true, min: 0 },
    unitPriceMax: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: "unidad" },
    quantity: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    isExtra: { type: Boolean, default: false },
  },
  { _id: false },
);

const historySchema = new Schema<IHistory>(
  {
    at: { type: Date, default: Date.now },
    by: { type: String, default: "" },
    action: { type: String, required: true },
    note: { type: String, default: "" },
  },
  { _id: false },
);

const bookingSchema = new Schema<IBooking>(
  {
    code: { type: String, required: true, unique: true },
    // Llave del enlace público de seguimiento: nunca sale en listados.
    accessToken: { type: String, required: true, select: false },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    source: { type: String, enum: ["web", "admin"], default: "web" },
    items: { type: [itemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    date: { type: String, required: true },
    time: { type: String, required: true },
    // date + time como instante: sirve para ordenar, "próximos" y la anticipación mínima.
    startAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 60 },
    address: { type: String, default: "" },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    status: { type: String, enum: BOOKING_STATUSES, default: "pending" },
    operators: [{ type: Schema.Types.ObjectId, ref: "User" }],
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: "pending" },
    amountPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    transferProofUrl: { type: String, default: "" },
    invoice: {
      required: { type: Boolean, default: false },
      name: { type: String, default: "" },
      documentId: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
    },
    officeQuote: { type: Schema.Types.ObjectId, ref: "OfficeQuote", default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

bookingSchema.index({ branch: 1, date: 1, time: 1 });
bookingSchema.index({ operators: 1, date: 1 });
bookingSchema.index({ customer: 1, createdAt: -1 });
bookingSchema.index({ startAt: 1 });

export const Booking = mongoose.model<IBooking>("Booking", bookingSchema);
