import mongoose, { Schema, Document, Types } from "mongoose";

/** Planes del catálogo: básico y profundo por m²; mensual = tarifa especial (sin precio automático). */
export const QUOTE_PLANS = ["basico", "profundo", "mensual"] as const;
export const QUOTE_STATUSES = ["new", "contacted", "won", "lost"] as const;

export interface IOfficeQuote extends Document {
  code: string;
  branch: Types.ObjectId | null;
  contact: { name: string; email: string; phone: string; company: string };
  squareMeters: number;
  plan: (typeof QUOTE_PLANS)[number];
  chairsFabric: number;
  chairsMixed: number;
  windows: number;
  bathrooms: number;
  notes: string;
  /** null = plan mensual (tarifa especial): el equipo cotiza y contacta. */
  estimate: number | null;
  breakdown: { label: string; amount: number }[];
  status: (typeof QUOTE_STATUSES)[number];
  booking: Types.ObjectId | null;
  createdAt: Date;
}

const officeQuoteSchema = new Schema<IOfficeQuote>(
  {
    code: { type: String, required: true, unique: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    contact: {
      name: { type: String, required: true },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      company: { type: String, default: "" },
    },
    squareMeters: { type: Number, default: 0 },
    plan: { type: String, enum: QUOTE_PLANS, default: "basico" },
    chairsFabric: { type: Number, default: 0 },
    chairsMixed: { type: Number, default: 0 },
    windows: { type: Number, default: 0 },
    bathrooms: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    estimate: { type: Number, default: null },
    breakdown: { type: [{ label: String, amount: Number, _id: false }], default: [] },
    status: { type: String, enum: QUOTE_STATUSES, default: "new" },
    booking: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
  },
  { timestamps: true, versionKey: false },
);

officeQuoteSchema.index({ status: 1, createdAt: -1 });

export const OfficeQuote = mongoose.model<IOfficeQuote>("OfficeQuote", officeQuoteSchema);
