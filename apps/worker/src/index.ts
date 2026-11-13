import { MessageChannel } from "node:worker_threads";
import { readServerConfig, ServerConfigError } from "@aevyra/config";
import { checkDatabase } from "@aevyra/db";

const checkOnly = process.argv.includes("--check");
const shutdown = new AbortController();
const stop = () => shutdown.abort();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

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
