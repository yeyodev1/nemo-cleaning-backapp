import mongoose, { Schema, Document } from "mongoose";

export interface IBankAccount {
  bank: string;
  type: string;
  number: string;
  holder: string;
  documentId: string;
}

export interface ISettings extends Document {
  key: string;
  businessName: string;
  notifyEmails: string[];
  bankAccounts: IBankAccount[];
  officePricing: {
    pricePerM2: number;
    pricePerChair: number;
    pricePerDesk: number;
    pricePerBathroom: number;
    minimum: number;
    frequencyDiscounts: { semanal: number; quincenal: number; mensual: number };
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
      pricePerM2: { type: Number, default: 120 },
      pricePerChair: { type: Number, default: 300 },
      pricePerDesk: { type: Number, default: 200 },
      pricePerBathroom: { type: Number, default: 800 },
      minimum: { type: Number, default: 4000 },
      frequencyDiscounts: {
        semanal: { type: Number, default: 10 },
        quincenal: { type: Number, default: 7 },
        mensual: { type: Number, default: 5 },
      },
    },
    bookingLeadHours: { type: Number, default: 12, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const Settings = mongoose.model<ISettings>("Settings", settingsSchema);
