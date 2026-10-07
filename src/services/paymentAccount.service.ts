import { getSettings } from "./settings.service";

/**
 * "Forma de pago con cuenta" de la columna "Pagos" del Excel. Las transferencias salen
 * de Configuración → cuentas bancarias; si aún no hay cuentas cargadas se usan las
 * cuatro que aparecen en la Base (Pichincha, Guayaquil, Pacífico, Produbanco).
 * `method` = método del pago que se registra; null = no entra dinero (canje, plan mensual).
 */
export interface PaymentAccount {
  label: string;
  method: "cash" | "transfer" | "card" | null;
}

const EXCEL_BANKS = ["Pichincha", "Guayaquil", "Pacífico", "Produbanco"];

/** "Banco del Pacífico" → "Pacífico", como lo escriben en la Base. */
export function shortBankName(bank: string): string {
  return bank
    .trim()
    .replace(/^banco\s+(de\s+|del\s+)?/i, "")
    .trim();
}

export async function listPaymentAccounts(): Promise<PaymentAccount[]> {
  const settings = await getSettings();
  const banks = [
    ...new Set((settings.bankAccounts ?? []).map((b) => shortBankName(b.bank || "")).filter(Boolean)),
  ];
  return [
    { label: "Efectivo", method: "cash" },
    ...(banks.length ? banks : EXCEL_BANKS).map((b) => ({
      label: `Transferencia ${b}`,
      method: "transfer" as const,
    })),
    { label: "Tarjeta (Payphone)", method: "card" },
    { label: "Plan mensual", method: null },
    { label: "Canje", method: null },
    // Como en la Base del Excel: sin cobro, no queda como cuenta por cobrar.
    { label: "Cortesía", method: null },
  ];
}

/** Método de un rótulo (también acepta rótulos viejos o escritos a mano). */
export function methodOfAccount(label: string): PaymentAccount["method"] {
  const l = label.toLowerCase();
  if (!l) return null;
  if (l.startsWith("efectivo")) return "cash";
  if (l.startsWith("transferencia")) return "transfer";
  if (l.startsWith("tarjeta")) return "card";
  return null;
}
