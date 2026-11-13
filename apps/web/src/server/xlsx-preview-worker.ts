import { parentPort, workerData } from "node:worker_threads";
import { ImportPreviewError } from "./import-preview-error.ts";
import type { PhoneCandidate } from "./phone-column-analysis.ts";
import { previewXlsx } from "./xlsx-preview.ts";
import type { XlsxPreviewOptions } from "./xlsx-preview.ts";

const { file, options } = workerData as { file: ArrayBuffer; options: XlsxPreviewOptions };
try {
  const candidates: PhoneCandidate[] = [];
  const result = await previewXlsx(Buffer.from(file), options, (candidate) => candidates.push(candidate));
  parentPort?.postMessage({ result, candidates });
} catch (error) {
  const failure = error instanceof ImportPreviewError
    ? error
    : new ImportPreviewError("XLSX прегледот моментално е недостапен.", 503);
  parentPort?.postMessage({ error: { message: failure.message, status: failure.status } });
}
