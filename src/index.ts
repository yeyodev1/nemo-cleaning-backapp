import "dotenv/config";
import { env } from "./config/env";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { seedBaseData } from "./services/seed.service";

async function main() {
  await dbConnect();
  await seedBaseData();

  const { server } = createApp();
  server.timeout = 10 * 60 * 1000;
  server.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
  });
}

main();
