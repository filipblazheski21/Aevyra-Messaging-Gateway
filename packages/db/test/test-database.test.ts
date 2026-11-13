import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { normalizeTestScenarioFailure, TestPostgresError } from "./test-database.ts";

test("датотечна грешка не се прикажува како PostgreSQL грешка", () => {
  const fileError = Object.assign(new Error("Синтетичка датотечна грешка."), { code: "EPERM" });

  assert.equal(normalizeTestScenarioFailure(fileError), fileError);
  assert.equal(fileError.message, "Синтетичка датотечна грешка.");
});

test("вистинска PostgreSQL грешка добива безбедна македонска порака", () => {
  const databaseError = new pg.DatabaseError("синтетички чувствителен детал", 0, "error");
  const normalized = normalizeTestScenarioFailure(databaseError);

  assert.ok(normalized instanceof TestPostgresError);
  assert.equal(normalized.message, "PostgreSQL операцијата во тест-базата не успеа.");
  assert.doesNotMatch(normalized.message, /чувствителен/);
  assert.equal(normalized.cause, undefined);
});
