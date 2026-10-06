import express from "express";
import * as healthController from "../controllers/health.controller";

const router = express.Router();
router.get("/", healthController.health);

export default router;
