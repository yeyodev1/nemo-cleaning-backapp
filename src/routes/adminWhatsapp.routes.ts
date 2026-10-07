import express from "express";
import * as whatsappController from "../controllers/adminWhatsapp.controller";
import { requireRoles } from "../middlewares/auth.middleware";

/** "Pedidos por WhatsApp" (se monta en /admin/whatsapp, ya autenticado). */
const router = express.Router();
const staff = requireRoles("admin", "manager");

router.get("/inbox", staff, whatsappController.inbox);
router.get("/count", staff, whatsappController.count);
router.get("/lookup", staff, whatsappController.lookup);
router.get("/customer", staff, whatsappController.customer);
router.post("/orders", staff, whatsappController.createOrder);
router.patch("/orders/:id", staff, whatsappController.handleOrder);

export default router;
