import express from "express";
import * as c from "../controllers/adminAccounting.controller";
import { requireRoles } from "../middlewares/auth.middleware";

/**
 * /admin/finance/* y /admin/commercial/* (fase 2). authMiddleware ya corrió en
 * routes/index.ts. Gerencia ve todo; el administrador de sucursal ve caja, cuentas por
 * cobrar, conciliación bancaria y comercial de sus sucursales.
 */
const finance = express.Router();
const commercial = express.Router();
const staff = requireRoles("admin", "manager");
const admin = requireRoles("admin");

finance.get("/fortnight", admin, c.fortnightReport);
finance.get("/annual", admin, c.annualStatement);
finance.get("/monthly", admin, c.monthlyDetail);

finance.post("/expenses/repeat-fixed", admin, c.repeatFixed);

finance.get("/payables", admin, c.listPayables);
finance.post("/payables", admin, c.createPayable);
finance.post("/payables/copy", admin, c.copyPayables);
finance.patch("/payables/:id", admin, c.updatePayable);
finance.delete("/payables/:id", admin, c.deletePayable);

finance.get("/payroll", admin, c.listPayroll);
finance.post("/payroll", admin, c.addPayroll);
finance.patch("/payroll/:id", admin, c.updatePayroll);
finance.delete("/payroll/:id", admin, c.deletePayroll);

finance.get("/cash", staff, c.cashRegister);
finance.post("/cash/movements", staff, c.createMovement);
finance.patch("/cash/movements/:id", staff, c.updateMovement);
finance.delete("/cash/movements/:id", staff, c.deleteMovement);

finance.get("/receivables", staff, c.receivablesAging);

finance.get("/bank", staff, c.bankReconciliation);
finance.patch("/bank/payments/:id", staff, c.verifyPayment);
finance.patch("/bank/statement", staff, c.saveStatement);

commercial.get("/zones", staff, c.zones);
commercial.get("/frequency", staff, c.frequency);
commercial.get("/portfolio", staff, c.portfolio);
commercial.patch("/portfolio/:id", staff, c.updateFollowUp);

export { finance as financeRoutes, commercial as commercialRoutes };
