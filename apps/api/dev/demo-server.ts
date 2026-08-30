import "reflect-metadata";

import { fileURLToPath } from "node:url";
import type { BattlefieldDatabase } from "@battlefield/database";
import { migrateDatabase } from "@battlefield/database";
import {
  createPgliteDatabase,
  seedSyntheticBusinessEntityDirectory,
} from "@battlefield/database/testing";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("The synthetic demo server cannot run in production.");
}

const migrationDirectory = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const database = await createPgliteDatabase<BattlefieldDatabase>();
console.info("Synthetic demo database created.");
await migrateDatabase(database.migrations, migrationDirectory);
console.info("Synthetic demo migrations applied.");
await seedSyntheticBusinessEntityDirectory(database);
console.info("Synthetic demo data seeded.");

const moduleReference = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(DATABASE_HANDLE)
  .useValue(database)
  .compile();
const app = moduleReference.createNestApplication();
configureApp(app);
await app.listen(process.env.PORT ?? 3001, "127.0.0.1");
console.info(
  `Synthetic demo API ready on http://127.0.0.1:${process.env.PORT ?? 3001}.`,
);

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
