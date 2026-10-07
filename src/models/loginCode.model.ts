import mongoose, { Schema, Document } from "mongoose";

export const LOGIN_AUDIENCES = ["staff", "customer"] as const;
export type LoginAudience = (typeof LOGIN_AUDIENCES)[number];

/**
 * Código de acceso de un solo uso. Hay como mucho uno vivo por correo y
 * audiencia: pedir otro reemplaza al anterior. Solo se guarda el hash.
 */
export interface ILoginCode extends Document {
  email: string;
  audience: LoginAudience;
  /** Vacío = no hay código válido (cuenta inexistente o código ya invalidado). */
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  /** Último envío: de aquí sale la espera de 60 s para reenviar. */
  sentAt: Date;
}

const loginCodeSchema = new Schema<ILoginCode>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    audience: { type: String, enum: LOGIN_AUDIENCES, required: true },
    codeHash: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

loginCodeSchema.index({ email: 1, audience: 1 }, { unique: true });
// TTL: Mongo borra el documento cuando vence (el barrido corre cada ~60 s,
// por eso el servicio también compara expiresAt).
loginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginCode = mongoose.model<ILoginCode>("LoginCode", loginCodeSchema);
