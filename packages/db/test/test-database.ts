import { randomBytes } from "node:crypto";
import pg from "pg";
import { isLocalDatabaseUrl, readLocalProjectDatabase, verifyLocalProjectDatabase } from "../src/local-project.ts";
import { appRoleMarker } from "../src/provision.ts";

const postgresFailureMessage = "PostgreSQL операцијата во тест-базата не успеа.";

export class TestPostgresError extends Error {}

export function normalizeTestScenarioFailure(error: unknown): unknown {
  return error instanceof pg.DatabaseError
    ? new TestPostgresError(postgresFailureMessage)
    : error;
}

function combineFailures(primary: unknown, cleanup: unknown): unknown {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError(
    [primary, cleanup],
    "Тест-сценариото не успеа, а потоа не успеа ни чистењето на PostgreSQL тест-ресурсите.",
  );
}

async function postgresOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof TestPostgresError
      ? error
      : new TestPostgresError(postgresFailureMessage);
  }
}

function cleanupFailure(errors: unknown[]): unknown {
  if (errors.length === 0) return undefined;
  const cause = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "Повеќе операции за чистење на PostgreSQL тест-ресурсите не успеаја.");
  return new Error("Чистењето на PostgreSQL тест-ресурсите не успеа.", { cause });
}

export function readTestTarget(env: NodeJS.ProcessEnv) {
  if (!env.TEST_DATABASE_ADMIN_URL) {
    throw new Error("Поставете TEST_DATABASE_ADMIN_URL за локалната административна база postgres.");
  }

  const adminUrl = URL.parse(env.TEST_DATABASE_ADMIN_URL);
  const project = readLocalProjectDatabase(env);
  if (!adminUrl || !isLocalDatabaseUrl(adminUrl, project.port) || adminUrl.pathname !== "/postgres"
      || adminUrl.username !== project.adminUrl.username) {
    throw new Error("Тест-целта мора да биде административната база postgres на локалниот проектен PostgreSQL, одделна од развојната база.");
  }

  return { adminUrl, project };
}

export function verifyTestTarget() {
  const target = readTestTarget(process.env);
  verifyLocalProjectDatabase(target.project);
  return target;
}

export async function withTestDatabase(
  { adminUrl, project }: ReturnType<typeof readTestTarget>,
  run: (client: pg.Client, databaseUrl: string, database: string) => Promise<void>,
) {
  const database = `aevyra_test_${randomBytes(16).toString("hex")}`;
  if (!/^aevyra_test_[a-f0-9]{32}$/.test(database) || database === project.database) {
    throw new Error("Небезбедно име на тест-базата.");
  }
  const identifier = pg.escapeIdentifier(database);
  const options = { connectionTimeoutMillis: 5_000, statement_timeout: 10_000, query_timeout: 12_000 };
  const admin = new pg.Client({ ...options, connectionString: adminUrl.href });
  const testUrl = new URL(adminUrl.href);
  testUrl.pathname = `/${database}`;
  const client = new pg.Client({ ...options, connectionString: testUrl.href });
  admin.on("error", () => {});
  client.on("error", () => {});
  let created = false;
  let failure: unknown;

  try {
    await postgresOperation(() => admin.connect());
    const target = await postgresOperation(() => admin.query(
      "SELECT current_database() AS name, current_setting('server_version_num')::int AS version",
    ));
    const { name, version } = target.rows[0];
    if (name !== "postgres" || version < 180000 || version >= 190000) {
      throw new Error("Тестовите бараат локална административна база postgres на PostgreSQL 18.");
    }
    const reserved = await postgresOperation(() => admin.query("SELECT FROM pg_roles WHERE rolname = $1", [database]));
    if (reserved.rowCount !== 0) throw new Error("Случајното име на тест-улогата е веќе зафатено.");

    await postgresOperation(() => admin.query(`CREATE DATABASE ${identifier} TEMPLATE template0`));
    created = true;
    await postgresOperation(() => client.connect());
    const connected = await postgresOperation(() => client.query("SELECT current_database() AS name"));
    if (connected.rows[0].name !== database) {
      throw new Error("Конекцијата не ја користи базата создадена за тековниот тест.");
    }
    await run(client, testUrl.href, database);
  } catch (error) {
    failure = normalizeTestScenarioFailure(error);
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await client.end();
    } catch {
      cleanupErrors.push(new Error("Затворањето на тест-конекцијата не успеа."));
    }
    if (created) {
      try {
        const { rows: [role] } = await postgresOperation(() => admin.query<{ oid: string; marker: string | null }>(`
          SELECT d.oid::text, shobj_description(r.oid, 'pg_authid') AS marker
          FROM pg_database d JOIN pg_roles r ON r.rolname = d.datname WHERE d.datname = $1
        `, [database]));
        // Без FORCE. Прекинувањето на други конекции е недозволено.
        await postgresOperation(() => admin.query(`DROP DATABASE ${identifier}`));
        if (role && role.marker === appRoleMarker(role.oid)) {
          await postgresOperation(() => admin.query(`DROP ROLE ${identifier}`));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await admin.end();
    } catch {
      cleanupErrors.push(new Error("Затворањето на административната тест-конекција не успеа."));
    }
    failure = combineFailures(failure, cleanupFailure(cleanupErrors));
  }
  if (failure !== undefined) throw failure;
}
