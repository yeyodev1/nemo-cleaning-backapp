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
/**
 * "whatsapp" = pago por coordinar por WhatsApp: el cliente terminó el pedido en el chat y
 * el asesor define después cómo paga. No es un método de `Payment` (esos son tarjeta,
 * efectivo o transferencia): al cobrar se registra el pago con su método real.
 */
export const PAYMENT_METHODS = ["card", "cash", "transfer", "whatsapp"] as const;
/** Origen del pedido. "whatsapp" = terminó en el chat (web con "Coordinar por WhatsApp" o pedido rápido del panel). */
export const BOOKING_SOURCES = ["web", "admin", "import", "whatsapp"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];
export const PAYMENT_STATUSES = ["pending", "review", "partial", "paid", "refunded"] as const;
/**
 * Confirmación del pago como la columna "Confirmacion" de la Base del Excel:
 * pendiente de confirmación (transferencia sin verificar), confirmado, pendiente de
 * pago (por cobrar), perdida (no se cobrará) y canje (sin cobro: intercambio/cortesía).
 */
export const PAYMENT_CONFIRMATIONS = [
  "pending_confirmation",
  "confirmed",
  "pending_payment",
  "lost",
  "exchange",
] as const;
export type PaymentConfirmation = (typeof PAYMENT_CONFIRMATIONS)[number];
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

/** Novedad (incidencia) de un servicio: hoja NOVEDADES del Excel. */
export interface INovedad {
  _id: Types.ObjectId;
  text: string;
  operator: Types.ObjectId | null;
  by: { id: string; name: string };
  at: Date;
}

export interface IBooking extends Document {
  code: string;
  accessToken: string;
  branch: Types.ObjectId;
  customer: Types.ObjectId;
  /** "import" = fila del Excel histórico (código HIS-…), cargada por `scripts/import-history.ts`. */
  source: BookingSource;
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
  /** Urbanización / zona del servicio (lista por sucursal, o texto libre si es "Otra"). */
  zone: string;
  /** Propina del cliente (centavos): no suma a la producción. */
  tip: number;
  /** Forma de pago con cuenta: "Efectivo", "Transferencia Pichincha"… */
  paymentAccount: string;
  paymentConfirmation: PaymentConfirmation;
  novedades: INovedad[];
  history: IHistory[];
  /** Lote de importación (p. ej. "excel-2026-10"): permite deshacer la carga histórica. */
  importBatch?: string;
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

const novedadSchema = new Schema<INovedad>({
  text: { type: String, required: true },
  operator: { type: Schema.Types.ObjectId, ref: "User", default: null },
  by: { type: new Schema({ id: String, name: String }, { _id: false }) },
  at: { type: Date, default: Date.now },
});

const bookingSchema = new Schema<IBooking>(
  {
    code: { type: String, required: true, unique: true },
    // Llave del enlace público de seguimiento: nunca sale en listados.
    accessToken: { type: String, required: true, select: false },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    source: { type: String, enum: BOOKING_SOURCES, default: "web" },
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
    zone: { type: String, default: "" },
    tip: { type: Number, default: 0, min: 0 },
    paymentAccount: { type: String, default: "" },
    paymentConfirmation: {
      type: String,
      enum: PAYMENT_CONFIRMATIONS,
      default: "pending_confirmation",
    },
    novedades: { type: [novedadSchema], default: [] },
    history: { type: [historySchema], default: [] },
    importBatch: { type: String },
  },
  { timestamps: true, versionKey: false },
);

bookingSchema.index({ branch: 1, date: 1, time: 1 });
bookingSchema.index({ operators: 1, date: 1 });
bookingSchema.index({ customer: 1, createdAt: -1 });
bookingSchema.index({ startAt: 1 });
bookingSchema.index({ "novedades.at": -1 });
// Reportes por rango de fechas sin sucursal (FEE, estado de resultados consolidado) y la Base.
bookingSchema.index({ date: 1, status: 1 });
bookingSchema.index({ importBatch: 1 }, { sparse: true });
// Bandeja "Pedidos por WhatsApp": pendientes del origen, más nuevos primero.
bookingSchema.index({ source: 1, status: 1, createdAt: -1 });

export const Booking = mongoose.model<IBooking>("Booking", bookingSchema);
