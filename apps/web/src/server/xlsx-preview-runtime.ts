import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { xlsxLimits } from "../import-preview.ts";
import type { XlsxPreview } from "../import-preview.ts";
import type { PhoneCandidate } from "./phone-column-analysis.ts";
import { ImportPreviewError } from "./import-preview-error.ts";
import type { XlsxPreviewOptions } from "./xlsx-preview.ts";

let activeUploads = 0;
type WorkerReply = { result: XlsxPreview; candidates: PhoneCandidate[] } | { error: { message: string; status: ImportPreviewError["status"] } };

export async function withBoundedImportUpload<T>(request: Request, run: (signal: AbortSignal) => Promise<T>) {
  if (activeUploads >= xlsxLimits.concurrent) {
    throw new ImportPreviewError("Во тек се повеќе прикачувања. Обидете се повторно.", 429);
  }
  activeUploads++;
  const timeout = AbortSignal.timeout(xlsxLimits.uploadMs);
  try {
    return await run(AbortSignal.any([request.signal, timeout]));
  } finally {
    activeUploads--;
  }
}
export async function readBoundedUpload<T>(request: Request, signal: AbortSignal, read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (request.signal.aborted) throw new ImportPreviewError("Прикачувањето е откажано.");
    if (signal.aborted) throw new ImportPreviewError("Истече времето за прикачување на датотеката.");
    throw error;
  }
}

export async function readXlsxInWorker(file: ArrayBuffer, options: XlsxPreviewOptions, signal: AbortSignal) {
  const cancelled = () => new ImportPreviewError("XLSX прегледот е откажан.");
  if (signal.aborted) throw cancelled();
  const source = "src/server/xlsx-preview-worker.ts";
  const fromRoot = resolve("apps/web", source);
  const worker = new Worker(existsSync(fromRoot) ? fromRoot : resolve(source), {
    workerData: { file, options },
    transferList: [file],
    execArgv: [],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: xlsxLimits.workerHeapMiB },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      const unavailable = () => new ImportPreviewError("XLSX прегледот моментално е недостапен. Обидете се повторно.", 503);
      worker.once("message", resolve);
      worker.once("error", (error) => reject("code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? new ImportPreviewError("XLSX прегледот го надмина ограничувањето за меморија.", 413)
        : unavailable()));
      worker.once("exit", () => reject(unavailable()));
      timer = setTimeout(() => reject(new ImportPreviewError("Истече времето за обработка на XLSX датотеката.", 503)), xlsxLimits.processingMs);
      abort = () => reject(cancelled());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    if ("error" in reply) throw new ImportPreviewError(reply.error.message, reply.error.status);
    return reply;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}


