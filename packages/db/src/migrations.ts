import { readdir } from "node:fs/promises";
import { parse } from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { withPostgresClient } from "./admin-client.ts";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const migrationsTable = "pgmigrations";
const historyTable = `public.${migrationsTable}`;
const operationTimeoutMs = 5 * 60_000;

export async function applyMigrations(databaseUrl: string, dir: string | string[] = migrationsDir) {
  return withPostgresClient(databaseUrl, operationTimeoutMs, (dbClient) => runner({
    dbClient,
    dir,
    useGlob: Array.isArray(dir),
    direction: "up",
    migrationsSchema: "public",
    migrationsTable,
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: "fail",
    // Сопствената команда ги прикажува само безбедните пораки.
    logger: { info() {}, warn() {}, error() {} },
  }));
}

export async function readMigrationStatus(databaseUrl: string) {
  const files = await readdir(migrationsDir, { withFileTypes: true });
  const names = files.filter((file) =>
    (file.isFile() || file.isSymbolicLink()) && !file.name.startsWith(".")
  ).map((file) => parse(file.name).name).sort();

  return withPostgresClient(databaseUrl, operationTimeoutMs, async (client) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [historyTable],
    );
    const hasHistory = result.rows[0].exists;
    const applied = hasHistory
      ? (await client.query<{ name: string }>(`SELECT name FROM ${historyTable} ORDER BY run_on, id`)).rows
        .map(({ name }) => name)
      : [];
    await client.query("COMMIT");
    return { hasHistory, applied, pending: names.filter((name) => !applied.includes(name)) };
  });
}
