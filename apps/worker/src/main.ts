import {
  type BattlefieldDatabase,
  createPostgresDatabase,
} from "@battlefield/database";

import { loadWorkerConfig } from "./config.js";
import { createReminderWorker, runWorkerLoop } from "./worker.js";

const config = loadWorkerConfig(process.env);
const database = createPostgresDatabase<BattlefieldDatabase>(
  config.databaseUrl,
  {
    applicationName: "battlefield-reminder-worker",
    maxConnections: 4,
  },
);
const controller = new AbortController();
const worker = createReminderWorker({
  database: database.db,
  actor: config.actor,
  batchSize: config.batchSize,
  leaseMs: config.leaseMs,
});

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runWorkerLoop(worker, {
    signal: controller.signal,
    idlePollMs: config.idlePollMs,
    busyPollMs: config.busyPollMs,
  });
} finally {
  await database.close();
}
