import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Seguimiento de cartera ("Gestión Comercial de Cartera"): intentos de contacto a un cliente
 * que lleva más de 60 días sin servicio y el resultado. Uno por cliente; si vuelve a
 * pedir, sale solo de la lista (su último servicio ya no tiene más de 60 días).
 */
export const FOLLOW_UP_RESULTS = ["pending", "accepted", "declined", "unreachable"] as const;

export interface ICustomerFollowUp extends Document {
  customer: Types.ObjectId;
  contact1At: Date | null;
  contact2At: Date | null;
  contact3At: Date | null;
  result: (typeof FOLLOW_UP_RESULTS)[number];
  notes: string;
  updatedBy?: { id: string; name: string };
  updatedAt: Date;
}

const followUpSchema = new Schema<ICustomerFollowUp>(
  {
    customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true, unique: true },
    contact1At: { type: Date, default: null },
    contact2At: { type: Date, default: null },
    contact3At: { type: Date, default: null },
    result: { type: String, enum: FOLLOW_UP_RESULTS, default: "pending" },
    notes: { type: String, default: "" },
    updatedBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

export const CustomerFollowUp = mongoose.model<ICustomerFollowUp>(
  "CustomerFollowUp",
  followUpSchema,
);
