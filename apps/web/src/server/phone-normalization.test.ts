import assert from "node:assert/strict";
import test from "node:test";
import { createPhoneColumnAnalysis } from "./phone-column-analysis.ts";
import { normalizePhone } from "./phone-normalization.ts";

test("Недвосмислени национални и меѓународни броеви се проверуваат со точен E.164", () => {
  for (const [input, expected, country, phoneType] of [
    ["070123456", "+38970123456", "MK", "MOBILE"],
    ["+38970123456", "+38970123456", "MK", "MOBILE"],
    ["0038970123456", "+38970123456", "MK", "MOBILE"],
    ["  (070) 123-456  ", "+38970123456", "MK", "MOBILE"],
    ["070-\u00a0123\u202f456", "+38970123456", "MK", "MOBILE"],
    ["+44 (20) 7946-0958", "+442079460958", "GB", "FIXED_LINE"],
    ["021234567", "+38921234567", "MK", "FIXED_LINE"],
    ["+39 02 12345678", "+390212345678", "IT", "FIXED_LINE"],
  ] as const) {
    const result = normalizePhone(input, "text");
    assert.deepEqual(result, {
      status: "VALID", reasonCode: "VALID_FORMAT", reason: "Форматот одговара на нумерациските правила.",
      normalizedPhone: expected, country, phoneType,
    });
  }
});

test("Празни, невалидни и двосмислени влезови добиваат стабилна причина без E.164", () => {
  for (const [input, status, reasonCode] of [
    ["", "EMPTY", "EMPTY_VALUE"],
    ["  \u00a0\u202f", "EMPTY", "EMPTY_VALUE"],
    ["07012", "INVALID", "INVALID_NUMBER"],
    ["+389701234567", "INVALID", "INVALID_NUMBER"],
    ["+3897012345678901", "INVALID", "INVALID_NUMBER"],
    ["+99970123456", "INVALID", "INVALID_NUMBER"],
    ["070123456 071123456", "INVALID", "INVALID_NUMBER"],
    ["ABC070123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["Јавете се на 070123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070123456 x123", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070123456;ext=123", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070123456/071123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["+38970123456 +38971123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["<b>070123456</b>", "INVALID", "UNSUPPORTED_CONTENT"],
    ['=TEXT(70123456,"000000000")', "INVALID", "UNSUPPORTED_CONTENT"],
    ["7.0123456E+7", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070\t123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070123456\n", "INVALID", "UNSUPPORTED_CONTENT"],
    ["\r\n", "INVALID", "UNSUPPORTED_CONTENT"],
    ["\u0000070123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070\u200b123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["(070 123-456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070)123456(", "INVALID", "UNSUPPORTED_CONTENT"],
    ["((070))123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["070+123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["(+389)70123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["-070123456", "INVALID", "UNSUPPORTED_CONTENT"],
    ["70123456", "REVIEW", "AMBIGUOUS_PREFIX"],
    ["38970123456", "REVIEW", "AMBIGUOUS_PREFIX"],
    ["+389(0)70123456", "REVIEW", "DIGITS_CHANGED"],
    ["+44 (0)20 7946 0958", "REVIEW", "DIGITS_CHANGED"],
    ["+54111523456789", "REVIEW", "DIGITS_CHANGED"],
  ] as const) {
    const result = normalizePhone(input, "text");
    assert.equal(result.status, status, JSON.stringify(input));
    assert.equal(result.reasonCode, reasonCode, JSON.stringify(input));
    assert.equal("normalizedPhone" in result, false);
    assert.match(result.reason, /\p{Script=Cyrillic}/u);
  }
  const numeric = normalizePhone("70123456", "number");
  assert.equal(numeric.status, "REVIEW");
  assert.equal(numeric.reasonCode, "NUMERIC_SOURCE");
  assert.equal("normalizedPhone" in numeric, false);
  assert.match(numeric.reason, /водечки нули/);
});

test("Дупликатите се само валидни E.164 совпаѓања и го покажуваат првиот изворен запис", () => {
  const analysis = createPhoneColumnAnalysis();
  for (const [recordNumber, value, sourceKind] of [
    [2, "070 123-456", "text"],
    [4, "+38970123456", "text"],
    [5, "0038970123456", "text"],
    [6, "+99970123456", "text"],
    [7, "+99970123456", "text"],
    [8, "70123456", "number"],
    [9, "70123456", "text"],
    [10, "", "empty"],
    [11, " \u00a0 ", "text"],
  ] as const) {
    analysis.add({ recordNumber, value }, sourceKind);
  }
  const result = analysis.finish(1);
  assert.deepEqual(result.analysis, {
    policyVersion: "phone-normalization-v1",
    counts: { excludedEmptyRecords: 1, emptyPhone: 2, invalid: 2, review: 2, uniqueValid: 1, duplicateValid: 2 },
  });
  assert.deepEqual(result.samples.slice(0, 3).map(({ phone }) => phone.status === "VALID" && [
    phone.normalizedPhone, phone.duplicate, phone.firstRecordNumber,
  ]), [
    ["+38970123456", false, 2], ["+38970123456", true, 2], ["+38970123456", true, 2],
  ]);
  assert.deepEqual(result.samples.slice(3).map(({ phone }) => phone.duplicate), Array(6).fill(false));
  assert.equal(result.samples[0].value, "070 123-456");
  const next = createPhoneColumnAnalysis();
  next.add({ recordNumber: 19, value: "070123456" }, "text");
  const { phone } = next.finish(0).samples[0];
  assert.equal(phone.duplicate, false);
  assert.equal(phone.status === "VALID" && phone.firstRecordNumber, 19);
});
