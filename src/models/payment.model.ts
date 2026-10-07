import mongoose, { Schema, Document, Types } from "mongoose";

export const PAYMENT_RECORD_STATUSES = [
  "pending",
  "review",
  "approved",
  "rejected",
  "refunded",
] as const;

export interface IPayment extends Document {
  booking: Types.ObjectId;
  bookingCode: string;
  branch: Types.ObjectId;
  customer: Types.ObjectId;
  amount: number;
  method: "card" | "cash" | "transfer";
  provider: "payphone" | "manual";
  status: (typeof PAYMENT_RECORD_STATUSES)[number];
  proofUrl: string;
  reference: string;
  clientTransactionId?: string;
  transactionId: string;
  /** Cuenta donde entró el dinero ("Transferencia Pichincha", "Efectivo"…), como la columna "Pagos" del Excel. */
  account: string;
  note: string;
  registeredBy?: { id: string; name: string };
  reviewedBy?: { id: string; name: string };
  reviewedAt?: Date;
  /** Cuándo entró el dinero: base de ingresos, caja y estado de resultados. */
  paidAt?: Date;
  /** Conciliación bancaria: se vio el dinero en el estado de cuenta. */
  verifiedAt?: Date | null;
  verifiedBy?: { id: string; name: string } | null;
  providerResponse?: unknown;
  /** Lote de importación del Excel histórico (permite deshacerla). */
  importBatch?: string;
  createdAt: Date;
}

const actorSchema = new Schema({ id: String, name: String }, { _id: false });

const paymentSchema = new Schema<IPayment>(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    bookingCode: { type: String, required: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer" },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ["card", "cash", "transfer"], required: true },
    provider: { type: String, enum: ["payphone", "manual"], default: "manual" },
    status: { type: String, enum: PAYMENT_RECORD_STATUSES, default: "pending" },
    proofUrl: { type: String, default: "" },
    reference: { type: String, default: "" },
    clientTransactionId: { type: String },
    transactionId: { type: String, default: "" },
    account: { type: String, default: "" },
    note: { type: String, default: "" },
    registeredBy: { type: actorSchema },
    reviewedBy: { type: actorSchema },
    reviewedAt: { type: Date },
    paidAt: { type: Date },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: actorSchema, default: null },
    // Respuesta cruda de Payphone para soporte: no sale en las respuestas.
    providerResponse: { type: Schema.Types.Mixed, select: false },
    importBatch: { type: String },
  },
  { timestamps: true, versionKey: false },
);

paymentSchema.index({ clientTransactionId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ booking: 1 });
paymentSchema.index({ status: 1, paidAt: -1 });
paymentSchema.index({ branch: 1, createdAt: -1 });
paymentSchema.index({ importBatch: 1 }, { sparse: true });

export const Payment = mongoose.model<IPayment>("Payment", paymentSchema);
