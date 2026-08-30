import { type Kysely, sql, type Transaction } from "kysely";

export interface ActorDatabaseContext {
  tenantId: string;
  userId: string;
  requestId: string;
}

export class InvalidActorDatabaseContextError extends Error {
  constructor(readonly field: keyof ActorDatabaseContext) {
    super(`Actor database context field ${field} must be a valid UUID.`);
    this.name = "InvalidActorDatabaseContextError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function withTenantTransaction<Database, Result>(
  db: Kysely<Database>,
  actor: ActorDatabaseContext,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  validateActor(actor);

  return db.transaction().execute(async (transaction) => {
    await sql`
      select
        set_config('app.current_tenant_id', ${actor.tenantId}, true),
        set_config('app.current_user_id', ${actor.userId}, true),
        set_config('app.request_id', ${actor.requestId}, true)
    `.execute(transaction);

    return work(transaction);
  });
}

function validateActor(actor: ActorDatabaseContext): void {
  for (const field of ["tenantId", "userId", "requestId"] as const) {
    if (!UUID_PATTERN.test(actor[field])) {
      throw new InvalidActorDatabaseContextError(field);
    }
  }
}
