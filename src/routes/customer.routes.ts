import express from "express";
import * as customerController from "../controllers/customer.controller";

// Pasa por customerAuthMiddleware en routes/index.ts.
const router = express.Router();
router.get("/me", customerController.me);
router.patch("/me", customerController.updateMe);
router.get("/bookings", customerController.bookings);

export default router;
