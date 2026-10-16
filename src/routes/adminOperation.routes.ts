import express from "express";
import * as operationController from "../controllers/adminOperation.controller";
import * as staffIncidentController from "../controllers/staffIncident.controller";
import * as collectionController from "../controllers/operatorCollection.controller";
import { requireRoles } from "../middlewares/auth.middleware";

/** Módulo "Operación" (fase 2): se monta dentro de /admin, ya autenticado. */
const router = express.Router();
const staff = requireRoles("admin", "manager");
const admin = requireRoles("admin");

router.get("/production/options", staff, operationController.productionOptions);
router.get("/production", staff, operationController.listProduction);
router.post("/production", staff, operationController.registerProduction);
router.patch("/bookings/:id/confirmation", staff, operationController.setConfirmation);

router.get("/novedades", staff, operationController.listNovedades);
router.post("/bookings/:id/novedades", staff, operationController.addNovedad);
router.delete("/bookings/:id/novedades/:nid", staff, operationController.deleteNovedad);

// Novedades del personal (llegó tarde, pelea, problema con cliente…).
// Cobros que reportan los operadores (efectivo por recibir / transferencias por confirmar).
router.get("/collections", staff, collectionController.list);
router.get("/collections/pending", staff, collectionController.pending);
router.post("/collections/:id/receive", staff, collectionController.receive);

router.get("/staff-incidents", staff, staffIncidentController.list);
router.post("/staff-incidents", staff, staffIncidentController.create);
router.delete("/staff-incidents/:id", staff, staffIncidentController.remove);

router.get("/shifts", staff, operationController.monthShifts);
router.put("/shifts", staff, operationController.saveShifts);

router.get("/goals", staff, operationController.monthGoals);
router.put("/goals", staff, operationController.saveGoal);
router.post("/goals/copy", staff, operationController.copyGoals);

// Comisiones manuales (las que usan los reportes) y la calculadora FEE (solo referencia).
router.get("/commissions/entries", staff, operationController.commissionEntries);
router.put("/commissions/entries", admin, operationController.saveCommissionEntry);
router.post("/commissions/entries/remove-row", admin, operationController.removeCommissionRow);
router.get("/commissions", staff, operationController.commissionSheet);
router.get("/commissions/rules", staff, operationController.commissionRule);
router.get("/commissions/goal-sheet", staff, operationController.commissionGoalSheet);
router.put("/commissions/rules", admin, operationController.updateCommissionRule);
router.post("/commissions/adjustments", admin, operationController.addAdjustment);
router.delete("/commissions/adjustments/:id", admin, operationController.deleteAdjustment);

export default router;
