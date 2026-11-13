import assert from "node:assert/strict";
import { test } from "node:test";
import { readServerConfig, ServerConfigError } from "./index.ts";

const databaseUrl = "postgresql://test_user:test_password@127.0.0.1:5432/test_db";

test("Испраќањето е оневозможено кога поставката недостасува", () => {
  assert.equal(readServerConfig({ DATABASE_URL: databaseUrl }).realSendingEnabled, false);
});

test("Текстуалната вредност false се чита како логичко false", () => {
  const config = readServerConfig({ DATABASE_URL: databaseUrl, REAL_SENDING_ENABLED: "false" });
  assert.equal(config.realSendingEnabled, false);
});

for (const value of ["true", "False", "1", "yes", "", " false "]) {
  test(`Поставката за испраќање ја одбива вредноста ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => readServerConfig({ DATABASE_URL: databaseUrl, REAL_SENDING_ENABLED: value }),
      { name: ServerConfigError.name, message: "REAL_SENDING_ENABLED мора да има вредност false." },
    );
  });
}

test("Недостасувачка адреса на базата дава конфигурациска грешка", () => {
  assert.throws(() => readServerConfig({}), {
    name: ServerConfigError.name,
    message: "Недостасува DATABASE_URL во серверската конфигурација.",
  });
});

test("Невалидната адреса не се вклучува во конфигурациската грешка", () => {
  assert.throws(() => readServerConfig({ DATABASE_URL: "https://test_password@127.0.0.1" }), {
    name: ServerConfigError.name,
    message: "DATABASE_URL мора да биде валидна PostgreSQL адреса.",
  });
});
