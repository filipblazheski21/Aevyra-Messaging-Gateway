import { readServerConfig, ServerConfigError } from "@aevyra/config";
import { checkDatabase } from "@aevyra/db";

export async function getDatabaseStatus() {
  try {
    const { databaseUrl } = readServerConfig();
    if (await checkDatabase(databaseUrl)) {
      return { ready: true, message: "Проверката на PostgreSQL успеа." };
    }
    return { ready: false, message: "Проверете дали PostgreSQL е стартуван и дали локалната конфигурација е точна." };
  } catch (error) {
    if (!(error instanceof ServerConfigError)) throw error;
    return { ready: false, message: error.message };
  }
}
