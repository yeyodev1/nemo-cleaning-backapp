import express from "express";
import * as authController from "../controllers/auth.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = express.Router();
router.post("/request-code", authController.requestCode);
router.post("/verify", authController.verify);
router.post("/login", authController.login);
router.post("/reset-password", authController.resetPassword);
router.get("/me", authMiddleware, authController.me);

export default router;
