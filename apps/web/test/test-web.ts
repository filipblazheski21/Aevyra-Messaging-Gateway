import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function reserveWebPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Тест-портата не е достапна.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function startTestWeb(port: number, config: Partial<NodeJS.ProcessEnv>) {
  const env = { ...process.env, ...config };
  for (const key of ["DATABASE_ADMIN_URL", "TEST_DATABASE_ADMIN_URL", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_PORT"]) {
    delete env[key];
  }
  const child = spawn(process.execPath, ["scripts/next.mjs", "start", "apps/web", "--hostname", "127.0.0.1", "--port", String(port)], {
    env, stdio: "ignore", windowsHide: true,
  });
  let closed = false;
  const finished = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
  child.on("error", () => {});
  const stop = async () => {
    if (!closed) child.kill();
    await finished;
  };

  const deadline = Date.now() + 12_000;
  while (!closed && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return stop;
    } catch {
      // Процесот сè уште се стартува.
    }
    await delay(100);
  }
  await stop();
  throw new Error("Тест-вебот не се стартува. Проверете дали продукциската изградба е достапна.");
}
