import { MessageChannel } from "node:worker_threads";
import { readServerConfig, ServerConfigError } from "@aevyra/config";
import { checkDatabase } from "@aevyra/db";
import pg from "pg";

const checkOnly = process.argv.includes("--check");
const shutdown = new AbortController();
const stop = () => shutdown.abort();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

export async function processNextSimulatedJob(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; organization_id: string }>(
      `
      SELECT j.id::text, j.organization_id::text
      FROM aevyra.message_jobs j
      WHERE NOT EXISTS (
        SELECT 1 FROM aevyra.message_job_events e
        WHERE e.job_id = j.id AND e.status IN ('SIMULATED_SENT', 'FAILED', 'CANCELLED')
      )
      AND pg_try_advisory_xact_lock(hashtext(j.id::text))
      ORDER BY j.created_at ASC, j.id ASC
      LIMIT 1
      `,
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const job = rows[0]!;
    await client.query(
      `INSERT INTO aevyra.message_job_events (job_id, organization_id, status, detail) VALUES ($1::uuid, $2::uuid, 'PROCESSING', 'Симулирана обработка.')`,
      [job.id, job.organization_id],
    );
    await client.query(
      `INSERT INTO aevyra.message_job_events (job_id, organization_id, status, detail) VALUES ($1::uuid, $2::uuid, 'SIMULATED_SENT', 'Симулирано испраќање (без надворешен канал).')`,
      [job.id, job.organization_id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log("Работниот процес не обработува пораки.");
  try {
    const config = readServerConfig();
    const databaseReady = await checkDatabase(config.databaseUrl);
    if (shutdown.signal.aborted) return;

    if (!databaseReady) {
      console.error("Базата на податоци е недостапна.");
      process.exitCode = 1;
      return;
    }

    console.log("Проверката на PostgreSQL успеа.");
    if (!checkOnly) {
      console.log("Работниот процес мирува. За запирање притиснете Ctrl+C.");
      // Портата го одржува процесот активен без тајмер или работа во заднина.
      const { port1, port2 } = new MessageChannel();
      port1.ref();
      await new Promise<void>((resolve) => {
        shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      port1.close();
      port2.close();
    }
  } catch (error) {
    console.error(error instanceof ServerConfigError ? error.message : "Проверката не успеа.");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (shutdown.signal.aborted) console.log("Работниот процес е запрен.");
  }
}

await main();
