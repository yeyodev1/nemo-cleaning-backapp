import "dotenv/config";
import type { Express } from "express";
import { dbConnect, isConnected } from "../src/config/mongo";
import { createApp } from "../src/app";
import { seedBaseData } from "../src/services/seed.service";

/**
 * Entrada para Vercel.
 *
 * El arranque se guarda como promesa, no como bandera: dos peticiones que
 * lleguen juntas a una instancia fría entrarían las dos al arranque y se
 * atenderían antes de que Mongo terminara de conectar.
 */
let arranque: Promise<Express> | null = null;

async function ensureApp(): Promise<Express> {
  if (!arranque) {
    arranque = (async () => {
      await dbConnect();
      await seedBaseData();
      return createApp().app;
    })().catch((error) => {
      // No se cachea un arranque fallido: la siguiente petición reintenta.
      arranque = null;
      throw error;
    });
  }

  const app = await arranque;
  if (!isConnected()) {
    const reconectado = await dbConnect();
    if (reconectado) await seedBaseData();
  }
  return app;
}

export default async function handler(req: any, res: any) {
  try {
    const application = await ensureApp();
    application(req, res);
  } catch (error) {
    console.error("[api] no se pudo iniciar la aplicación:", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Servicio no disponible. Intenta de nuevo." }));
  }
}
