import express from "express";
import * as operationController from "../controllers/adminOperation.controller";
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

router.get("/shifts", staff, operationController.monthShifts);
router.put("/shifts", staff, operationController.saveShifts);

router.get("/goals", staff, operationController.monthGoals);
router.put("/goals", staff, operationController.saveGoal);
router.post("/goals/copy", staff, operationController.copyGoals);

router.get("/commissions", staff, operationController.commissionSheet);
router.get("/commissions/rules", staff, operationController.commissionRule);
router.put("/commissions/rules", admin, operationController.updateCommissionRule);
router.post("/commissions/adjustments", admin, operationController.addAdjustment);
router.delete("/commissions/adjustments/:id", admin, operationController.deleteAdjustment);

export default router;
