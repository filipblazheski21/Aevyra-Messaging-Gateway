import assert from "node:assert/strict";
import test from "node:test";
import { selectMessageChannel } from "./channel-selection.ts";

test("Viber има приоритет кога е потврден, а инаку оди на SMS", () => {
  assert.equal(
    selectMessageChannel({
      suppressed: false,
      viberAvailable: true,
      viberBasisValid: true,
      smsBasisValid: true,
      hasUncertainViberAttempt: false,
    }),
    "VIBER",
  );

  assert.equal(
    selectMessageChannel({
      suppressed: false,
      viberAvailable: false,
      viberBasisValid: true,
      smsBasisValid: true,
      hasUncertainViberAttempt: false,
    }),
    "SMS",
  );
});

test("Неизвесен Viber обид или Не контактирај не прават автоматски SMS fallback", () => {
  assert.equal(
    selectMessageChannel({
      suppressed: false,
      viberAvailable: false,
      viberBasisValid: true,
      smsBasisValid: true,
      hasUncertainViberAttempt: true,
    }),
    "NONE",
  );

  assert.equal(
    selectMessageChannel({
      suppressed: true,
      viberAvailable: true,
      viberBasisValid: true,
      smsBasisValid: true,
      hasUncertainViberAttempt: false,
    }),
    "NONE",
  );
});
