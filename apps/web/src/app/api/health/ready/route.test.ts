import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { GET } from "./route.ts";

test("Проверката на базата враќа 503 и безбеден одговор при истекување на времето за конекција", async (context) => {
  const sockets = new Set<Socket>();
  let acceptedConnection = false;
  const server = createServer((socket) => {
    acceptedConnection = true;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const previousUrl = process.env.DATABASE_URL;
  const previousFlag = process.env.REAL_SENDING_ENABLED;
  context.after(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousFlag === undefined) delete process.env.REAL_SENDING_ENABLED;
    else process.env.REAL_SENDING_ENABLED = previousFlag;
  });

  process.env.DATABASE_URL = `postgresql://test_user:test_secret@127.0.0.1:${address.port}/test_db`;
  process.env.REAL_SENDING_ENABLED = "false";

  const started = performance.now();
  const response = await GET();
  assert.ok(acceptedConnection, "Тест-сервисот мора да ја прифати TCP конекцијата.");
  assert.ok(performance.now() - started < 4000, "Проверката мора да заврши во ограничено време.");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "недостапна",
    message: "Базата на податоци е недостапна.",
  });
});
