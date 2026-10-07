import mongoose, { Schema, Document } from "mongoose";

export interface IBankAccount {
  bank: string;
  type: string;
  number: string;
  holder: string;
  documentId: string;
}

export interface ITier {
  minQty: number;
  unitPrice: number;
}

export const DEFAULT_WINDOW_TIERS: ITier[] = [
  { minQty: 2, unitPrice: 800 },
  { minQty: 6, unitPrice: 650 },
  { minQty: 11, unitPrice: 500 },
];
export const DEFAULT_BATHROOM_TIERS: ITier[] = [
  { minQty: 1, unitPrice: 2500 },
  { minQty: 2, unitPrice: 2000 },
  { minQty: 4, unitPrice: 1800 },
];

const tierType = { type: [{ minQty: Number, unitPrice: Number, _id: false }] };

export interface ISettings extends Document {
  key: string;
  businessName: string;
  notifyEmails: string[];
  bankAccounts: IBankAccount[];
  /** Tarifas reales del catálogo Home & Office (centavos). El plan mensual es tarifa especial: sin precio. */
  officePricing: {
    basicPerM2: number;
    deepPerM2: number;
    chairFabric: number;
    chairMixed: number;
    windowTiers: ITier[];
    bathroomTiers: ITier[];
  };
  bookingLeadHours: number;
}

const settingsSchema = new Schema<ISettings>(
  {
    // Singleton: siempre key = "main".
    key: { type: String, default: "main", unique: true },
    businessName: { type: String, default: "Nemo Cleaning Services" },
    notifyEmails: { type: [String], default: [] },
    bankAccounts: {
      type: [
        {
          bank: String,
          type: { type: String },
          number: String,
          holder: String,
          documentId: String,
          _id: false,
        },
      ],
      default: [],
    },
    officePricing: {
      basicPerM2: { type: Number, default: 250 },
      deepPerM2: { type: Number, default: 300 },
      chairFabric: { type: Number, default: 650 },
      chairMixed: { type: Number, default: 700 },
      windowTiers: { ...tierType, default: () => DEFAULT_WINDOW_TIERS },
      bathroomTiers: { ...tierType, default: () => DEFAULT_BATHROOM_TIERS },
    },
    bookingLeadHours: { type: Number, default: 12, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const Settings = mongoose.model<ISettings>("Settings", settingsSchema);
