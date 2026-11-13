import assert from "node:assert/strict";
import test from "node:test";
import { estimateSmsSegments, extractTemplateVariables, renderTemplateBody } from "./sms-segments.ts";

test("GSM-7 пресметува 160 за еден и 153 за повеќе сегменти", () => {
  const single = estimateSmsSegments("a".repeat(160));
  assert.deepEqual(single, { encoding: "GSM-7", characterCount: 160, segmentCount: 1, perSegmentLimit: 160 });

  const multi = estimateSmsSegments("a".repeat(161));
  assert.deepEqual(multi, { encoding: "GSM-7", characterCount: 161, segmentCount: 2, perSegmentLimit: 153 });
});

test("Кирилицата користи UCS-2 со 70 и 67 знаци по сегмент", () => {
  const single = estimateSmsSegments("б".repeat(70));
  assert.deepEqual(single, { encoding: "UCS-2", characterCount: 70, segmentCount: 1, perSegmentLimit: 70 });

  const multi = estimateSmsSegments("б".repeat(71));
  assert.deepEqual(multi, { encoding: "UCS-2", characterCount: 71, segmentCount: 2, perSegmentLimit: 67 });
});

test("Непозната променлива или празна вредност се одбиваат при замрзнување", () => {
  assert.deepEqual(extractTemplateVariables("Здраво {{ime}}, термин {{datum}}."), ["ime", "datum"]);

  const unknown = renderTemplateBody("Здраво {{nepoznata}}.", ["ime"], { ime: "Ана" });
  assert.equal(unknown.ok, false);

  const missing = renderTemplateBody("Здраво {{ime}}.", ["ime"], { ime: "   " });
  assert.equal(missing.ok, false);

  const valid = renderTemplateBody("Здраво {{ime}}.", ["ime"], { ime: "Ана" });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.rendered, "Здраво Ана.");
    assert.equal(valid.estimate.encoding, "UCS-2");
    assert.equal(valid.estimate.segmentCount, 1);
  }
});
