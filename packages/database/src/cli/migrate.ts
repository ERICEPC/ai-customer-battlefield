import { fileURLToPath } from "node:url";

import { createPostgresDatabase } from "../database-factory.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { migrateDatabase } from "../migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run PostgreSQL migrations.");
}

const migrationDirectory = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
const database = createPostgresDatabase<BattlefieldDatabase>(databaseUrl, {
  applicationName: "ai-customer-battlefield-migrator",
  maxConnections: 2,
});

try {
  const migrations = await migrateDatabase(
    database.migrations,
    migrationDirectory,
  );
  if (migrations.length === 0) {
    console.info("Database schema is already current.");
  } else {
    console.info(
      `Applied migrations: ${migrations.map((migration) => migration.name).join(", ")}.`,
    );
  }
} finally {
  await database.close();
}
