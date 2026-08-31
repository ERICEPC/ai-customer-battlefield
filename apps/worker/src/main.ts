import { randomUUID } from "node:crypto";
import {
  type BattlefieldDatabase,
  createPostgresDatabase,
  KyselyWorkerHeartbeatStore,
} from "@battlefield/database";
import { createNotificationChannels } from "./channels/channel-registry.js";
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
const channels = createNotificationChannels({
  tenantId: config.actor.tenantId,
  feishu: config.feishu,
});
const worker = createReminderWorker({
  database: database.db,
  actor: config.actor,
  batchSize: config.batchSize,
  leaseMs: config.leaseMs,
  channels,
});
const heartbeat = new KyselyWorkerHeartbeatStore(database.db);

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runWorkerLoop(worker, {
    signal: controller.signal,
    idlePollMs: config.idlePollMs,
    busyPollMs: config.busyPollMs,
    heartbeat: {
      reporter: heartbeat,
      actor: config.actor,
      workerKey: "reminder_worker",
      instanceId: randomUUID(),
      leaseMs: config.leaseMs,
    },
  });
} finally {
  await database.close();
}
