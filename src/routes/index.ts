import express, { Application } from "express";
import adminRoutes from "./admin.routes";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import operatorRoutes from "./operator.routes";
import publicRoutes from "./public.routes";
import { authMiddleware } from "../middlewares/auth.middleware";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  router.use("/auth", authRoutes);
  router.use("/public", publicRoutes);

  // Sesión validada una sola vez aquí; cada router aplica sus gates de rol.
  router.use("/admin", authMiddleware, adminRoutes);
  router.use("/operator", authMiddleware, operatorRoutes);

  router.use((_req, res) => {
    res.status(404).json({ message: "Ruta no encontrada" });
  });
}

export default routerApi;
