export class ServerConfigError extends Error {
  override name = "ServerConfigError";
}

function readPostgresUrl(env: NodeJS.ProcessEnv, key: "DATABASE_URL" | "DATABASE_ADMIN_URL") {
  const value = env[key];
  if (!value) {
    throw new ServerConfigError(`Недостасува ${key} во серверската конфигурација.`);
  }
  const url = URL.parse(value);
  if (!url?.hostname || !["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new ServerConfigError(`${key} мора да биде валидна PostgreSQL адреса.`);
  }
  return value;
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.REAL_SENDING_ENABLED !== undefined && env.REAL_SENDING_ENABLED !== "false") {
    throw new ServerConfigError("REAL_SENDING_ENABLED мора да има вредност false.");
  }

  return { databaseUrl: readPostgresUrl(env, "DATABASE_URL"), realSendingEnabled: false as const };
}

export function readDatabaseAdminUrl(env: NodeJS.ProcessEnv = process.env) {
  return readPostgresUrl(env, "DATABASE_ADMIN_URL");
}
