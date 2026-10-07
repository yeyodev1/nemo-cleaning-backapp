import express from "express";
import * as customerController from "../controllers/customer.controller";

const router = express.Router();
router.post("/request-code", customerController.requestCode);
router.post("/verify", customerController.verify);

export default router;
