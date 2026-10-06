import express from "express";
import cors from "cors";
import http from "http";
import routerApi from "./routes";
import { env } from "./config/env";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

const whitelist = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  env.FRONTEND_URL,
  ...env.CORS_ORIGINS,
]);

/** Previews de Vercel del front: permitidos. */
const allowedPatterns: RegExp[] = [/^https:\/\/nemo-cleaning[a-z0-9-]*\.vercel\.app$/i];

function isOriginAllowed(origin: string): boolean {
  return whitelist.has(origin) || allowedPatterns.some((p) => p.test(origin));
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Sin Origin (curl, server-to-server, la redirección de Payphone) se deja pasar.
    if (!origin || isOriginAllowed(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

export function createApp() {
  const app = express();
  // Vercel termina TLS en su proxy.
  app.set("trust proxy", 1);

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => {
    res.send("Nemo Cleaning API");
  });

  routerApi(app);
  app.use(globalErrorHandler);

  const server = http.createServer(app);
  return { app, server };
}
