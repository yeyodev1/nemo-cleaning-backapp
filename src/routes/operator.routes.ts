import express from "express";
import * as operatorController from "../controllers/operator.controller";
import { requireRoles } from "../middlewares/auth.middleware";

const router = express.Router();
router.use(requireRoles("operator"));
router.get("/bookings", operatorController.myBookings);
router.patch("/bookings/:id/status", operatorController.changeStatus);
router.post("/bookings/:id/novedades", operatorController.addNovedad);

export default router;
