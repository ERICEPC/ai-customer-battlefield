import {
  type BattlefieldDatabase,
  createPostgresDatabase,
  type DatabaseHandle,
} from "@battlefield/database";
import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";

export const DATABASE_HANDLE = Symbol("DATABASE_HANDLE");
export type ApplicationDatabaseHandle =
  DatabaseHandle<BattlefieldDatabase> | null;

function createDatabaseFromEnvironment(): ApplicationDatabaseHandle {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return createPostgresDatabase<BattlefieldDatabase>(databaseUrl, {
      applicationName: "ai-customer-battlefield-api",
    });
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production.");
  }
  return null;
}

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(DATABASE_HANDLE)
    private readonly database: ApplicationDatabaseHandle,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.database?.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      useFactory: createDatabaseFromEnvironment,
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE_HANDLE],
})
export class DatabaseModule {}
