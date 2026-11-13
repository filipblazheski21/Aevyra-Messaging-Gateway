import assert from "node:assert/strict";
import test from "node:test";
import { sendViaSmsGate } from "./sms-gateway.ts";

const config = {
  baseUrl: "http://10.150.163.129:8080",
  username: "sms",
  password: "secret",
};

test("SMSGate 2xx со id враќа ACCEPTED", async () => {
  const outcome = await sendViaSmsGate(
    config,
    { idempotencyKey: "job-1", phoneNumber: "+38970000001", message: "Тест" },
    async () => new Response(JSON.stringify({ id: "job-1", state: "Pending" }), { status: 202 }),
  );
  assert.deepEqual(outcome, { status: "ACCEPTED", externalId: "job-1" });
});

test("SMSGate 4xx враќа FAILED, а 5xx или мрежна грешка враќа UNKNOWN", async () => {
  const failed = await sendViaSmsGate(
    config,
    { idempotencyKey: "job-2", phoneNumber: "+38970000001", message: "Тест" },
    async () => new Response("Bad Request", { status: 400 }),
  );
  assert.equal(failed.status, "FAILED");

  const unknown = await sendViaSmsGate(
    config,
    { idempotencyKey: "job-3", phoneNumber: "+38970000001", message: "Тест" },
    async () => {
      throw new Error("ECONNRESET");
    },
  );
  assert.equal(unknown.status, "UNKNOWN");
});
