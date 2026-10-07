import mongoose, { Schema, Document, Types } from "mongoose";

export const ROLES = ["admin", "manager", "operator"] as const;

export interface IUser extends Document {
  name: string;
  email: string;
  phone: string;
  /** Legado: el acceso es por código al correo. Se conserva por los documentos viejos. */
  password?: string;
  role: (typeof ROLES)[number];
  branches: Types.ObjectId[];
  active: boolean;
  color: string;
  lastLoginAt?: Date;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    password: { type: String, select: false },
    role: { type: String, enum: ROLES, default: "operator" },
    branches: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
    active: { type: Boolean, default: true },
    color: { type: String, default: "#19C3B8" },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

export const User = mongoose.model<IUser>("User", userSchema);
