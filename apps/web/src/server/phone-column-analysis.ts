import { phonePolicyVersion, previewLimits } from "../import-preview.ts";
import type { AnalyzedPhoneSample, ImportPreview, ImportSample, PhoneSourceKind } from "../import-preview.ts";
import { normalizePhone } from "./phone-normalization.ts";

export type PhoneCandidate = { normalizedPhone: string; sourceRecordNumber: number };
export type CollectPhoneCandidate = (candidate: PhoneCandidate) => void;

export function createPhoneColumnAnalysis<Sample extends ImportSample>(collect?: CollectPhoneCandidate) {
  const firstRecords = new Map<string, number>();
  const samples: AnalyzedPhoneSample<Sample>[] = [];
  const counts = { emptyPhone: 0, invalid: 0, review: 0, uniqueValid: 0, duplicateValid: 0 };

  return {
    add(sample: Sample, sourceKind: PhoneSourceKind) {
      const phone = normalizePhone(sample.value, sourceKind);
      if (phone.status === "VALID") {
        const first = firstRecords.get(phone.normalizedPhone);
        if (first === undefined) {
          firstRecords.set(phone.normalizedPhone, sample.recordNumber);
          counts.uniqueValid++;
          collect?.({ normalizedPhone: phone.normalizedPhone, sourceRecordNumber: sample.recordNumber });
        } else {
          counts.duplicateValid++;
        }
        if (samples.length < previewLimits.samples) {
          samples.push({
            ...sample, sourceKind,
            phone: { ...phone, duplicate: first !== undefined, firstRecordNumber: first ?? sample.recordNumber },
          });
        }
      } else {
        if (phone.status === "EMPTY") counts.emptyPhone++;
        else if (phone.status === "INVALID") counts.invalid++;
        else counts.review++;
        if (samples.length < previewLimits.samples) samples.push({ ...sample, sourceKind, phone: { ...phone, duplicate: false } });
      }
    },
    finish(excludedEmptyRecords: number): Pick<ImportPreview<Sample>, "samples" | "analysis"> {
      return { samples, analysis: { policyVersion: phonePolicyVersion, counts: { excludedEmptyRecords, ...counts } } };
    },
  };
}
