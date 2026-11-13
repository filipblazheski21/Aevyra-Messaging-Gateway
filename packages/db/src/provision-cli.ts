import { readServerConfig, ServerConfigError } from "@aevyra/config";
import { readLocalProjectDatabase, verifyLocalProjectDatabase } from "./local-project.ts";
import { appRole, provisionAppRole } from "./provision.ts";

try {
  if (process.argv.length !== 2) {
    throw new ServerConfigError("Користете db:provision без дополнителни аргументи.");
  }
  const target = readLocalProjectDatabase();
  const appUrl = new URL(readServerConfig().databaseUrl);
  if (appUrl.username !== appRole) {
    throw new ServerConfigError("DATABASE_URL мора да ја користи локалната апликациска улога aevyra_app.");
  }
  verifyLocalProjectDatabase(target);
  const created = await provisionAppRole(target.adminUrl, appUrl);
  console.log(created
    ? "Ограничената апликациска улога е создадена и проверена."
    : "Правата и конекцијата на постојната апликациска улога се проверени.");
} catch (error) {
  console.error(error instanceof ServerConfigError ? error.message
    : "Подготовката не успеа. Проверете ги миграциите, овластувањата и локалните поставки.");
  process.exitCode = 1;
}
