import "reflect-metadata";

import { fileURLToPath } from "node:url";
import type { BattlefieldDatabase } from "@battlefield/database";
import { migrateDatabase } from "@battlefield/database";
import {
  createPgliteDatabase,
  seedSyntheticAcceptedAction,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticInboxNotification,
  seedSyntheticManagementObserver,
  seedSyntheticReminderConfiguration,
} from "@battlefield/database/testing";
import { createReminderWorker, runWorkerLoop } from "@battlefield/worker";
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
await seedSyntheticManagementObserver(database);
await seedSyntheticReminderConfiguration(database);
await seedSyntheticAcceptedAction(database);
await seedSyntheticInboxNotification(database, {
  reminderId: "72000000-0000-4000-8000-000000000071",
  notificationId: "f0000000-0000-4000-8000-000000000071",
  recipientUserId: "30000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-31T00:08:00.000Z",
});
console.info("Synthetic demo data seeded.");

const workerController = new AbortController();
const worker = createReminderWorker({
  database: database.db,
  actor: {
    tenantId: "10000000-0000-4000-8000-000000000001",
    userId: "30000000-0000-4000-8000-000000000001",
  },
  batchSize: 50,
  leaseMs: 60_000,
  channels: [],
});
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

let shuttingDown = false;
const workerLoop = runWorkerLoop(worker, {
  signal: workerController.signal,
  idlePollMs: 250,
  busyPollMs: 50,
});
void workerLoop.catch((error: unknown) => {
  console.error(
    "Synthetic reminder worker stopped unexpectedly.",
    error instanceof Error ? error.message : "Unknown worker error.",
  );
  void shutdown(1);
});

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  workerController.abort();
  await workerLoop.catch(() => {});
  await app.close();
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
