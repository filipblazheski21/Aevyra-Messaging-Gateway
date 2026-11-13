import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { readAuthSettings } from "./auth-settings.ts";

const secret = randomBytes(32).toString("base64url");

test("Auth бара сопствена валидна тајна", () => {
  assert.throws(() => readAuthSettings({ AUTH_BASE_URL: "https://aevyra.example.test" }), /AUTH_SECRET/);
  assert.throws(() => readAuthSettings({ AUTH_SECRET: "невалидна", AUTH_BASE_URL: "https://aevyra.example.test" }), /AUTH_SECRET/);
});

test("HTTP исклучокот е експлицитен и важи само за loopback", () => {
  assert.equal(readAuthSettings({ AUTH_SECRET: secret, AUTH_BASE_URL: "https://aevyra.example.test" }).secureCookies, true);
  assert.equal(readAuthSettings({ AUTH_SECRET: secret, AUTH_BASE_URL: "http://127.0.0.1:3000", AUTH_LOCAL_HTTP: "true" }).secureCookies, false);
  assert.throws(() => readAuthSettings({ AUTH_SECRET: secret, AUTH_BASE_URL: "http://127.0.0.1:3000" }), /AUTH_BASE_URL/);
  assert.throws(() => readAuthSettings({ AUTH_SECRET: secret, AUTH_BASE_URL: "http://aevyra.example.test", AUTH_LOCAL_HTTP: "true" }), /AUTH_BASE_URL/);
  assert.throws(() => readAuthSettings({ AUTH_SECRET: secret, AUTH_BASE_URL: "https://aevyra.example.test/app" }), /AUTH_BASE_URL/);
});
