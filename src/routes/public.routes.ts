import express from "express";
import * as publicController from "../controllers/public.controller";
import { optionalCustomerAuth } from "../middlewares/customerAuth.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";

const router = express.Router();

router.get("/branches", publicController.branches);
router.get("/services", publicController.services);
router.get("/settings", publicController.settings);
router.get("/availability", publicController.availability);
router.post("/quote", publicController.quote);

router.post("/bookings", optionalCustomerAuth, publicController.createBooking);
router.get("/bookings/:code", publicController.getBooking);
router.post(
  "/bookings/:code/transfer-proof",
  uploadMiddleware.single("file"),
  publicController.transferProof,
);
router.post("/bookings/:code/cancel", publicController.cancelBooking);
router.post("/bookings/:code/payphone", publicController.restartPayphone);
router.post("/payphone/confirm", publicController.confirmPayphone);

router.post("/office-quotes", publicController.createOfficeQuote);
router.post("/uploads/proof", uploadMiddleware.single("file"), publicController.uploadProof);

export default router;
