import { MessageChannel } from "node:worker_threads";
import { readServerConfig, ServerConfigError } from "@aevyra/config";
import { checkDatabase, claimSmsGateway } from "@aevyra/db";
import pg from "pg";
import { isWithinWorkingHours, randomSendIntervalMs } from "./scheduler.ts";
import { sendViaSmsGate } from "./sms-gateway.ts";

const checkOnly = process.argv.includes("--check");
const sendMode = process.argv.includes("--send");
const shutdown = new AbortController();
const stop = () => shutdown.abort();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const TERMINAL_STATUSES = "'SENT', 'SIMULATED_SENT', 'FAILED', 'CANCELLED', 'SKIPPED'";
const IDLE_DELAY_MS = 5_000;
const OUTSIDE_HOURS_DELAY_MS = 60_000;

function readWorkingHours(): { start: number; end: number } {
  const start = Number.parseInt(process.env.WORKING_HOURS_START ?? "8", 10);
  const end = Number.parseInt(process.env.WORKING_HOURS_END ?? "20", 10);
  const valid = Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && start < 24 && end > 0 && end <= 24 && start < end;
  return valid ? { start, end } : { start: 8, end: 20 };
}

export type JobOutcome =
  | { kind: "idle" }
  | { kind: "no-gateway" }
  | { kind: "skipped"; reason: string }
  | { kind: "sent"; gateway: string; externalId: string }
  | { kind: "failed"; gateway: string; reason: string };

interface QueueJob {
  id: string;
  organization_id: string;
  campaign_id: string;
  channel: "SMS" | "VIBER";
  frozen_body: string;
  idempotency_key: string;
  suppressed: boolean;
}

const pickNextJob = `
  SELECT j.id::text, j.organization_id::text, j.campaign_id::text, j.channel, j.frozen_body, j.idempotency_key,
    EXISTS (
      SELECT 1 FROM aevyra.contact_suppressions cs
      WHERE cs.organization_id = j.organization_id AND cs.contact_id = j.contact_id
    ) AS suppressed
  FROM aevyra.message_jobs j
  WHERE NOT EXISTS (
      SELECT 1 FROM aevyra.message_job_events e
      WHERE e.job_id = j.id AND e.status IN (${TERMINAL_STATUSES})
    )
    AND (
      SELECT ce.action
      FROM aevyra.campaign_control_events ce
      WHERE ce.campaign_id = j.campaign_id
      ORDER BY ce.created_at DESC, ce.id DESC
      LIMIT 1
    ) IN ('START', 'RESUME')
    AND pg_try_advisory_xact_lock(hashtext(j.id::text))
  ORDER BY j.created_at ASC, j.id ASC
  LIMIT 1
`;

async function recordEvent(
  client: pg.Client,
  job: { id: string; organization_id: string },
  status: string,
  detail: string,
) {
  await client.query(
    `INSERT INTO aevyra.message_job_events (job_id, organization_id, status, detail) VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [job.id, job.organization_id, status, detail],
  );
}

async function processNextJob(
  databaseUrl: string,
  transport: (
    input: { idempotencyKey: string; message: string; phoneNumber: string },
    gateway: { baseUrl: string; username: string; password: string },
  ) => Promise<
    { status: "ACCEPTED"; externalId: string } | { status: "FAILED" | "UNKNOWN"; reason: string }
  >,
  options: { simulates: boolean },
): Promise<JobOutcome> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<QueueJob>(pickNextJob);
    const job = rows[0];
    if (!job) {
      await client.query("ROLLBACK");
      return { kind: "idle" };
    }

    if (job.channel !== "SMS") {
      await recordEvent(client, job, "SKIPPED", "Viber пораките се испраќаат рачно од контактниот список.");
      await client.query("COMMIT");
      return { kind: "skipped", reason: "VIBER" };
    }
    if (job.suppressed) {
      await recordEvent(client, job, "SKIPPED", "Контактот е означен со „Не контактирај“.");
      await client.query("COMMIT");
      return { kind: "skipped", reason: "SUPPRESSED" };
    }

    const gateway = await claimSmsGateway(client);
    if (!gateway) {
      await client.query("ROLLBACK");
      return { kind: "no-gateway" };
    }
    await client.query(
      `UPDATE aevyra.message_jobs SET gateway_id = $1::uuid WHERE id = $2::uuid`,
      [gateway.id, job.id],
    );
    await recordEvent(client, job, "PROCESSING", `Пораката е преземена од редицата (${gateway.name}).`);
    await client.query("COMMIT");

    const phoneNumber = await readPhoneNumber(databaseUrl, job);
    if (!phoneNumber) {
      await finishJob(databaseUrl, job, "FAILED", `Телефонот ${gateway.name} не може да го прочита бројот.`);
      return { kind: "failed", gateway: gateway.name, reason: "CONTACT_MISSING" };
    }

    if (options.simulates) {
      await finishJob(databaseUrl, job, "SIMULATED_SENT", `Симулирано испраќање преку ${gateway.name}.`);
      return { kind: "sent", gateway: gateway.name, externalId: "simulated" };
    }

    const outcome = await transport({
      idempotencyKey: job.idempotency_key,
      message: job.frozen_body,
      phoneNumber,
    }, gateway);
    if (outcome.status === "ACCEPTED") {
      await finishJob(databaseUrl, job, "SENT", `Испратено преку ${gateway.name} (${outcome.externalId}).`);
      return { kind: "sent", gateway: gateway.name, externalId: outcome.externalId };
    }
    await finishJob(databaseUrl, job, "FAILED", `Неуспешно испраќање преку ${gateway.name}: ${outcome.reason}`);
    return { kind: "failed", gateway: gateway.name, reason: outcome.reason };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function readPhoneNumber(databaseUrl: string, job: QueueJob): Promise<string | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ normalized_phone: string }>(
      `SELECT normalized_phone FROM aevyra.contacts WHERE id = (
        SELECT contact_id FROM aevyra.message_jobs WHERE id = $1::uuid
      )`,
      [job.id],
    );
    return rows[0]?.normalized_phone ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

async function finishJob(databaseUrl: string, job: QueueJob, status: string, detail: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await recordEvent(client, job, status, detail);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function processNextSimulatedJob(databaseUrl: string): Promise<boolean> {
  const outcome = await processNextJob(
    databaseUrl,
    async () => ({ status: "ACCEPTED", externalId: "simulated" }),
    { simulates: true },
  );
  return outcome.kind === "sent" || outcome.kind === "skipped" || outcome.kind === "failed";
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    shutdown.signal.addEventListener("abort", finish, { once: true });
  });
}

async function runLoop(databaseUrl: string, realSending: boolean) {
  const hours = readWorkingHours();
  console.log(
    realSending
      ? "Работниот процес испраќа SMS пораки преку телефоните од „SMS телефони“."
      : "Работниот процес работи во симулиран режим (без вистинско испраќање).",
  );

  while (!shutdown.signal.aborted) {
    if (!isWithinWorkingHours(new Date(), hours.start, hours.end)) {
      console.log(`Надвор од работното време (${hours.start}–${hours.end} часот по Скопје). Пауза од една минута.`);
      await wait(OUTSIDE_HOURS_DELAY_MS);
      continue;
    }

    let outcome: JobOutcome;
    try {
      outcome = await processNextJob(
        databaseUrl,
        realSending
          ? async (input, gateway) => sendViaSmsGate(gateway, input)
          : async () => ({ status: "ACCEPTED", externalId: "simulated" }),
        { simulates: !realSending },
      );
    } catch (error) {
      console.error("Грешка при обработка на порака:", error instanceof Error ? error.message : error);
      await wait(IDLE_DELAY_MS);
      continue;
    }

    if (outcome.kind === "sent" || outcome.kind === "failed") {
      const intervalMs = randomSendIntervalMs();
      console.log(`Пораката е обработена. Следната за ${Math.round(intervalMs / 1000)} секунди.`);
      await wait(intervalMs);
      continue;
    }
    if (outcome.kind === "no-gateway") {
      console.log("Нема активен SMS телефон. Додајте или вклучете телефон во „SMS телефони“.");
    } else if (outcome.kind === "skipped") {
      console.log(`Пораката е прескокната (${outcome.reason}).`);
    }
    await wait(IDLE_DELAY_MS);
  }
}

async function main() {
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
    if (checkOnly) return;

    if (sendMode) {
      await runLoop(config.databaseUrl, true);
    } else {
      console.log("Работниот процес мирува. За испраќање користете „npm run worker:send“.");
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
