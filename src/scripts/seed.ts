import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { seedBaseData } from "../services/seed.service";

/** pnpm seed — sucursales, catálogo, settings y admin. Idempotente: se puede correr las veces que sea. */
async function main() {
  await dbConnect();
  await seedBaseData();
  console.log("[seed] listo");
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[seed] falló:", error);
  await mongoose.disconnect();
  process.exit(1);
});
