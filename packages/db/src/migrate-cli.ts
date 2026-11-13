import { readDatabaseAdminUrl, ServerConfigError } from "@aevyra/config";
import { applyMigrations, readMigrationStatus } from "./migrations.ts";

const [, , command, ...args] = process.argv;

try {
  if (args.length > 0 || (command !== "up" && command !== "status")) {
    throw new ServerConfigError("Користете db:migrate или db:migrate:status без дополнителни аргументи.");
  }
  const databaseUrl = readDatabaseAdminUrl();

  if (command === "status") {
    const { hasHistory, applied, pending } = await readMigrationStatus(databaseUrl);
    console.log(hasHistory ? "Миграциската историја постои." : "Миграциската историја сè уште не постои.");
    console.log(`Применети (${applied.length})${applied.length ? ` — ${applied.join(", ")}` : ""}`);
    console.log(`За примена (${pending.length})${pending.length ? ` — ${pending.join(", ")}` : ""}`);
  } else {
    const applied = await applyMigrations(databaseUrl);
    console.log(applied.length
      ? `Применети миграции (${applied.length}) — ${applied.map(({ name }) => name).join(", ")}`
      : "Нема нови миграции за примена.");
  }
} catch (error) {
  if (error instanceof ServerConfigError) {
    console.error(error.message);
  } else if (error instanceof Error && error.message.startsWith("Another migration is already running.")) {
    console.error("Друга миграција веќе се извршува. Повторете ја командата откако ќе заврши.");
  } else {
    console.error("Миграциската команда не успеа. Проверете ја достапноста, овластувањата и миграциите.");
  }
  process.exitCode = 1;
}
