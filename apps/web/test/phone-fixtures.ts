import assert from "node:assert/strict";
import { normalizePhone } from "../src/server/phone-normalization.ts";

export function bulkSyntheticPhones() {
  const phones: string[] = [];
  // Синтетички NANP записи од опсегот 555-0100 до 555-0199.
  for (let area = 200; area <= 999 && phones.length < 20_000; area++) {
    const probe = normalizePhone(`+1${area}5550100`, "text");
    if (probe.status !== "VALID" || probe.country !== "US") continue;
    for (let line = 100; line <= 199; line++) phones.push(`+1${area}5550${line}`);
  }
  assert.equal(phones.length, 20_000);
  return phones;
}
