import mongoose, { Schema, Document, Types } from "mongoose";

export interface ICustomer extends Document {
  name: string;
  email: string;
  phone: string;
  documentId: string;
  address: string;
  /** Última referencia y ubicación GPS: se precargan en el próximo pedido. */
  reference: string;
  location: { lat: number | null; lng: number | null; accuracy: number; url: string } | null;
  notes: string;
  branch: Types.ObjectId | null;
  totalOrders: number;
  totalSpent: number;
  /** Lote de importación del Excel histórico (permite deshacerla). */
  importBatch?: string;
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
    reference: { type: String, default: "" },
    location: {
      type: new Schema(
        {
          lat: { type: Number, default: null },
          lng: { type: Number, default: null },
          accuracy: { type: Number, default: 0 },
          url: { type: String, default: "" },
        },
        { _id: false },
      ),
      default: null,
    },
    notes: { type: String, default: "" },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    totalOrders: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    importBatch: { type: String },
  },
  { timestamps: true, versionKey: false },
);

customerSchema.index({ email: 1 });
customerSchema.index({ phone: 1 });
customerSchema.index({ importBatch: 1 }, { sparse: true });

export const Customer = mongoose.model<ICustomer>("Customer", customerSchema);
