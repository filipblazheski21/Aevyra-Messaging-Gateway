import assert from "node:assert/strict";
import test from "node:test";
import { canSendUnderChannelLimit, clampSendIntervalSeconds, isWithinWorkingHours, randomSendIntervalMs } from "./scheduler.ts";

test("работните часови се проверуваат во Europe/Skopje", () => {
  // 2026-01-15T07:30:00Z -> 08:30 CET (within 08..20)
  assert.equal(isWithinWorkingHours(new Date("2026-01-15T07:30:00Z"), 8, 20), true);
  // 2026-01-15T06:30:00Z -> 07:30 CET (before 08)
  assert.equal(isWithinWorkingHours(new Date("2026-01-15T06:30:00Z"), 8, 20), false);
});

test("интервалот е ограничен на 15-45 секунди и лимитот по канал се почитува", () => {
  assert.equal(clampSendIntervalSeconds(5), 15);
  assert.equal(clampSendIntervalSeconds(30), 30);
  assert.equal(clampSendIntervalSeconds(90), 45);
  assert.equal(canSendUnderChannelLimit(9, 10), true);
  assert.equal(canSendUnderChannelLimit(10, 10), false);
  const ms = randomSendIntervalMs(15, 45, () => 0.5);
  assert.ok(ms >= 15_000 && ms <= 45_000);
});
