import mongoose, { Schema, Document, Types } from "mongoose";

export interface ICustomer extends Document {
  name: string;
  email: string;
  phone: string;
  documentId: string;
  address: string;
  notes: string;
  branch: Types.ObjectId | null;
  totalOrders: number;
  totalSpent: number;
  createdAt: Date;
}

const customerSchema = new Schema<ICustomer>(
  {
    // Puede quedar vacío: quien entra por primera vez con su correo lo completa en "Mi cuenta".
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    documentId: { type: String, default: "", trim: true },
    address: { type: String, default: "" },
    notes: { type: String, default: "" },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    totalOrders: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

customerSchema.index({ email: 1 });
customerSchema.index({ phone: 1 });

export const Customer = mongoose.model<ICustomer>("Customer", customerSchema);
