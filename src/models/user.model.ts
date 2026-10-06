import mongoose, { Schema, Document, Types } from "mongoose";
import bcrypt from "bcryptjs";

export const ROLES = ["admin", "manager", "operator"] as const;

export interface IUser extends Document {
  name: string;
  email: string;
  phone: string;
  password: string;
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
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: "operator" },
    branches: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
    active: { type: Boolean, default: true },
    color: { type: String, default: "#19C3B8" },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

export const User = mongoose.model<IUser>("User", userSchema);
