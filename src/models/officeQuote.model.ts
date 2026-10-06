import mongoose, { Schema, Document, Types } from "mongoose";

export const QUOTE_FREQUENCIES = ["unica", "semanal", "quincenal", "mensual"] as const;
export const QUOTE_STATUSES = ["new", "contacted", "won", "lost"] as const;

export interface IOfficeQuote extends Document {
  code: string;
  branch: Types.ObjectId | null;
  contact: { name: string; email: string; phone: string; company: string };
  squareMeters: number;
  chairs: number;
  desks: number;
  bathrooms: number;
  frequency: (typeof QUOTE_FREQUENCIES)[number];
  notes: string;
  estimate: number;
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
    chairs: { type: Number, default: 0 },
    desks: { type: Number, default: 0 },
    bathrooms: { type: Number, default: 0 },
    frequency: { type: String, enum: QUOTE_FREQUENCIES, default: "unica" },
    notes: { type: String, default: "" },
    estimate: { type: Number, default: 0 },
    breakdown: { type: [{ label: String, amount: Number, _id: false }], default: [] },
    status: { type: String, enum: QUOTE_STATUSES, default: "new" },
    booking: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
  },
  { timestamps: true, versionKey: false },
);

officeQuoteSchema.index({ status: 1, createdAt: -1 });

export const OfficeQuote = mongoose.model<IOfficeQuote>("OfficeQuote", officeQuoteSchema);
