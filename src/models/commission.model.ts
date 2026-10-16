import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Regla del FEE (hojas "FEE <MES>" del Excel). Excedente = producción del día − base;
 * el % sale del tramo de mayor `above` que el excedente supera (en centavos).
 */
export interface ICommissionTier {
  above: number;
  percent: number;
}

export interface ICommissionException {
  operator: Types.ObjectId;
  tiers: ICommissionTier[];
  note: string;
}

export interface ICommissionRule extends Document {
  key: string;
  dailyBase: number;
  tiers: ICommissionTier[];
  supervisorPercent: number;
  exceptions: ICommissionException[];
  /** Día en que arranca el período: 1 = mes calendario; 16 = del 16 del mes anterior al 15. */
  periodStartDay: 1 | 16;
  /** Sobre qué se mide la producción: lo cobrado (con descuento) o el precio de lista. */
  productionBasis: "total" | "subtotal";
  /** Supervisor: % del excedente de cada operador, o un monto fijo por período. */
  supervisorMode: "percent" | "fixed";
  /** Monto fijo del supervisor por período (centavos), si `supervisorMode` = fixed. */
  supervisorFixed: number;
  /** Comisión por meta mensual: % de cada dólar sobre la meta, por sucursal. */
  branchPercents: { branch: Types.ObjectId; percent: number }[];
}

const tierSchema = new Schema<ICommissionTier>(
  { above: { type: Number, min: 0 }, percent: { type: Number, min: 0, max: 100 } },
  { _id: false },
);

/**
 * Tramos inferidos de 1.033 celdas de FEE (oct-2025 a mar-2026): ≤ $10 → 30 %,
 * $10–15 → 33 %, $15–20 → 35 %, $20–25 → 37 %, $25–30 → 39 %, $30–35 → 40 %, > $35 → 50 %.
 */
export const DEFAULT_TIERS: ICommissionTier[] = [
  { above: 0, percent: 30 },
  { above: 1000, percent: 33 },
  { above: 1500, percent: 35 },
  { above: 2000, percent: 37 },
  { above: 2500, percent: 39 },
  { above: 3000, percent: 40 },
  { above: 3500, percent: 50 },
];

const commissionRuleSchema = new Schema<ICommissionRule>(
  {
    key: { type: String, default: "main", unique: true },
    dailyBase: { type: Number, default: 6000, min: 0 },
    tiers: { type: [tierSchema], default: () => DEFAULT_TIERS },
    supervisorPercent: { type: Number, default: 14, min: 0, max: 100 },
    periodStartDay: { type: Number, enum: [1, 16], default: 1 },
    productionBasis: { type: String, enum: ["total", "subtotal"], default: "total" },
    supervisorMode: { type: String, enum: ["percent", "fixed"], default: "percent" },
    supervisorFixed: { type: Number, default: 0, min: 0 },
    branchPercents: {
      type: [
        new Schema(
          { branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true }, percent: { type: Number, min: 0, max: 100, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    exceptions: {
      type: [
        new Schema<ICommissionException>(
          {
            operator: { type: Schema.Types.ObjectId, ref: "User", required: true },
            tiers: { type: [tierSchema], default: [] },
            note: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);

export const CommissionRule = mongoose.model<ICommissionRule>(
  "CommissionRule",
  commissionRuleSchema,
);

/** Ajuste manual con nota (bono, descuento por queja…), suma o resta al FEE del día. */
export interface ICommissionAdjustment extends Document {
  date: string;
  operator: Types.ObjectId;
  /** Sucursal a la que se carga (la del operador): así el estado de resultados por sucursal la incluye. */
  branch: Types.ObjectId | null;
  kind: "operator" | "supervisor";
  amount: number;
  note: string;
  createdBy?: { id: string; name: string };
  createdAt: Date;
}

const adjustmentSchema = new Schema<ICommissionAdjustment>(
  {
    date: { type: String, required: true },
    operator: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    kind: { type: String, enum: ["operator", "supervisor"], default: "operator" },
    // Puede ser negativo (descuento).
    amount: { type: Number, required: true },
    note: { type: String, required: true },
    createdBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

adjustmentSchema.index({ date: 1 });

export const CommissionAdjustment = mongoose.model<ICommissionAdjustment>(
  "CommissionAdjustment",
  adjustmentSchema,
);
