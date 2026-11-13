import { execFileSync } from "node:child_process";
import { readDatabaseAdminUrl, ServerConfigError } from "@aevyra/config";

export function isLocalDatabaseUrl(url: URL, port: string) {
  return ["postgres:", "postgresql:"].includes(url.protocol)
    && url.hostname === "127.0.0.1" && (url.port || "5432") === port
    && !url.search && !url.hash && Boolean(url.username && url.password);
}

export function readLocalProjectDatabase(env: NodeJS.ProcessEnv = process.env) {
  const adminUrl = new URL(readDatabaseAdminUrl(env));
  const database = env.POSTGRES_DB;
  const adminRole = env.POSTGRES_USER;
  const port = env.POSTGRES_PORT || "5432";
  if (!database || ["postgres", "template0", "template1"].includes(database) || database.startsWith("aevyra_test_")
      || !adminRole || !isLocalDatabaseUrl(adminUrl, port)
      || adminUrl.username !== encodeURIComponent(adminRole) || adminUrl.pathname !== `/${encodeURIComponent(database)}`) {
    throw new ServerConfigError("Административната адреса мора да одговара на локалната развојна база и администраторот од Compose.");
  }
  return { adminUrl, database, adminRole, port };
}

export function verifyLocalProjectDatabase({ port, database, adminRole }: ReturnType<typeof readLocalProjectDatabase>) {
  const compose = (args: string[]) => execFileSync("docker", [
    "--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "compose", "--env-file", ".env.admin", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();

  let binding, identity;
  try {
    binding = compose(["port", "postgres", "5432"]);
    identity = compose(["exec", "-T", "postgres", "printenv", "POSTGRES_DB", "POSTGRES_USER"]);
  } catch {
    throw new ServerConfigError("Проверката на локалниот проектен Docker Compose PostgreSQL не успеа.");
  }
  if (binding !== `127.0.0.1:${port}` || identity.replaceAll("\r\n", "\n") !== `${database}\n${adminRole}`) {
    throw new ServerConfigError("Портата, базата или администраторот не се совпаѓаат со активниот проектен контејнер.");
  }
}
