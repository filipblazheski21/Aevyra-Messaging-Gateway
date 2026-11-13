import { previewFileSize, previewLimits } from "../import-preview.ts";
import type { ImportSourceFormat } from "../import-preview.ts";
import { ImportPreviewError } from "./import-preview-error.ts";

const bodyLimit = previewLimits.fileBytes + previewLimits.multipartOverheadBytes;

export async function readImportForm(request: Request, label: string, fields: readonly string[], signal?: AbortSignal) {
  const contentType = request.headers.get("Content-Type");
  if (contentType?.split(";")[0].trim().toLowerCase() !== "multipart/form-data") {
    throw new ImportPreviewError(`Испратете ${label} датотека преку формата за преглед.`, 415);
  }
  const tooLarge = () => new ImportPreviewError(`Барањето е преголемо. Изберете ${label} датотека до ${previewFileSize}.`, 413);
  if (Number(request.headers.get("Content-Length")) > bodyLimit) throw tooLarge();
  if (!request.body) throw new ImportPreviewError(`Недостасува ${label} датотека.`);

  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const chunks: Uint8Array[] = [];
  let size = 0;
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) {
        cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const body = new Response(Buffer.concat(chunks, size), { headers: { "Content-Type": contentType } });
  const form = await body.formData().catch(() => {
    throw new ImportPreviewError("Формата за преглед не е валидна.");
  });
  const names = [...form.keys()];
  if (new Set(names).size !== names.length || names.some((key) => !fields.includes(key))) {
    throw new ImportPreviewError("Формата содржи недозволени полиња.");
  }
  return form;
}

const csvMediaTypes = new Set([
  "", "text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream",
]);

export function readImportFile(form: FormData, format: ImportSourceFormat) {
  const label = format.toUpperCase();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name) throw new ImportPreviewError(`Изберете ${label} датотека.`);
  if (!file.name.toLowerCase().endsWith(`.${format}`) || (format === "csv" && !csvMediaTypes.has(file.type.split(";")[0]))) {
    throw new ImportPreviewError(`Поддржани се само ${label} датотеки (.${format}).`, 415);
  }
  if (file.size > previewLimits.fileBytes) throw new ImportPreviewError(`${label} датотеката надминува ${previewFileSize}.`, 413);
  return file;
}

export function readPreviewSelection(form: FormData) {
  const header = form.get("hasHeader");
  const column = form.get("phoneColumn");
  if (header !== "true" && header !== "false") {
    throw new ImportPreviewError("Означете дали првиот ред содржи имиња на колони.");
  }
  if (column !== null && (typeof column !== "string" || !/^(0|[1-9][0-9]?)$/.test(column))) {
    throw new ImportPreviewError("Изберете постоечка телефонска колона.");
  }
  return { hasHeader: header === "true", phoneColumn: column === null ? null : Number(column) };
}
