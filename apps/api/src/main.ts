import "reflect-metadata";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("api/v1");
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3001);
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && currentModulePath === resolve(process.argv[1])) {
  await bootstrap();
}
