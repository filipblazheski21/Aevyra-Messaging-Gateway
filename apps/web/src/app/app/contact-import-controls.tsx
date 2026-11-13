import { useEffect, useRef, useState } from "react";
import { csvDelimiters, formatPreviewCount, previewFileSize, previewLimits, xlsxLimits } from "../../import-preview.ts";
import type {
  ContactImportHistoryEntry, ContactImportResult, ImportConfirmation, ImportPreview, ImportSourceFormat, PhoneAnalysisCounts, XlsxPreview, XlsxSheet,
} from "../../import-preview.ts";
import { errorMessage, primaryButton, RegistryError, RegistryRequestError, registryRequest, secondaryButton } from "./registry-ui.tsx";

export type PreviewResponse = ({ format: "csv"; preview: ImportPreview } | XlsxPreview) & { confirmation?: ImportConfirmation };
type ConfirmedPreview = { format: ImportSourceFormat; preview: ImportPreview; confirmation: ImportConfirmation; sheet: XlsxSheet | null };
type Outcome = { code: "IMPORT_SAVED"; result: ContactImportResult } | { code: "PENDING"; message: string };

const pathFor = (organizationId: string) => `/${organizationId}/imports`;
const unknownMessage = "Исходот на увозот е непознат. Проверете го пред повторно зачувување.";

function storeAttempt(key: string, attempt: ImportConfirmation | null) {
  try {
    if (attempt) sessionStorage.setItem(key, JSON.stringify(attempt));
    else sessionStorage.removeItem(key);
  } catch {
    // The current page can still check and retry using its in-memory state.
  }
}

function readAttempt(key: string): ImportConfirmation | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 4096) return null;
    const { receipt, idempotencyKey, expiresAt, source } = JSON.parse(raw);
    if (typeof receipt !== "string" || receipt.length > 2048
        || typeof idempotencyKey !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(idempotencyKey)
        || !Number.isSafeInteger(expiresAt) || !source || typeof source.hasHeader !== "boolean"
        || !Number.isInteger(source.phoneColumn) || source.phoneColumn < 0 || source.phoneColumn >= previewLimits.columns) return null;
    const { hasHeader, phoneColumn } = source;
    if (source.format === "csv" && typeof source.delimiter === "string" && Object.hasOwn(csvDelimiters, source.delimiter)) {
      return { receipt, idempotencyKey, expiresAt, source: { format: "csv", hasHeader, phoneColumn, delimiter: source.delimiter } };
    }
    if (source.format === "xlsx" && Number.isInteger(source.sheetIndex) && source.sheetIndex >= 0 && source.sheetIndex < xlsxLimits.sheets) {
      return { receipt, idempotencyKey, expiresAt, source: { format: "xlsx", hasHeader, phoneColumn, sheetIndex: source.sheetIndex } };
    }
  } catch {
    // Stored metadata can be absent, malformed, or inaccessible.
  }
  return null;
}

function readOutcome(organizationId: string, attempt: ImportConfirmation, signal: AbortSignal) {
  const query = new URLSearchParams({ idempotencyKey: attempt.idempotencyKey });
  return registryRequest<Outcome>(`${pathFor(organizationId)}?${query}`, { signal });
}

export function useContactImport(organizationId: string, operatorId: string) {
  const storageKey = `aevyra.contact-import.v1:${operatorId}:${organizationId}`;
  const running = useRef(false);
  const [attempt, setAttempt] = useState<ImportConfirmation | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [operation, setOperation] = useState<"checking" | "saving" | "renewing" | null>(null);
  const [result, setResult] = useState<ContactImportResult | null>(null);
  const [renewed, setRenewed] = useState<ConfirmedPreview | null>(null);
  const [message, setMessage] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function restore() {
      const previous = readAttempt(storageKey);
      if (!previous || controller.signal.aborted) return;
      running.current = true;
      setAttempt(previous);
      setExpired(Date.now() >= previous.expiresAt);
      setOperation("checking");
      try {
        const response = await readOutcome(organizationId, previous, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (controller.signal.aborted) return;
        if (response.code === "IMPORT_SAVED") {
          storeAttempt(storageKey, null);
          setAttempt(null);
          setResult(response.result);
        } else {
          setMessage(response.message);
        }
      } catch {
        if (!controller.signal.aborted) setMessage(unknownMessage);
      } finally {
        if (!controller.signal.aborted) {
          running.current = false;
          setOperation(null);
        }
      }
    }
    void Promise.resolve().then(restore);
    return () => controller.abort();
  }, [organizationId, storageKey]);

  function finish(saved: ContactImportResult) {
    storeAttempt(storageKey, null);
    setAttempt(null);
    setFile(null);
    setRenewed(null);
    setMessage("");
    setResult(saved);
  }

  async function run(kind: NonNullable<typeof operation>, action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setOperation(kind);
    setMessage("");
    try {
      await action();
    } finally {
      running.current = false;
      setOperation(null);
    }
  }

  async function check() {
    if (!attempt) return;
    await run("checking", async () => {
      try {
        const response = await readOutcome(organizationId, attempt, AbortSignal.timeout(15_000));
        if (response.code === "IMPORT_SAVED") finish(response.result);
        else setMessage(response.message);
      } catch {
        setMessage(unknownMessage);
      }
    });
  }

  async function save(original: File, confirmation: ImportConfirmation) {
    await run("saving", async () => {
      setResult(null);
      setRenewed(null);
      setFile(original);
      setAttempt(confirmation);
      setExpired(Date.now() >= confirmation.expiresAt);
      storeAttempt(storageKey, confirmation);
      const form = new FormData();
      form.set("file", original);
      form.set("receipt", confirmation.receipt);
      try {
        const response = await registryRequest<Extract<Outcome, { code: "IMPORT_SAVED" }>>(pathFor(organizationId), {
          method: "POST", body: form, signal: AbortSignal.timeout(45_000),
        });
        if (response.code !== "IMPORT_SAVED" || !response.result) throw new Error();
        finish(response.result);
      } catch (error) {
        if (!(error instanceof RegistryRequestError) || error.code === "OUTCOME_UNKNOWN" || !error.code) {
          setMessage(unknownMessage);
        } else {
          if (error.code === "PREVIEW_EXPIRED") {
            setExpired(true);
            setFile(null);
          }
          setMessage(error.message);
          if (!attempt && ["INVALID_REQUEST", "INVALID_RECEIPT", "PREVIEW_MISMATCH", "IMPORT_LIMIT_EXCEEDED"].includes(error.code)) {
            storeAttempt(storageKey, null);
            setAttempt(null);
          }
        }
      }
    });
  }

  async function renew() {
    if (!attempt || !file) return;
    await run("renewing", async () => {
      if (file.size > previewLimits.fileBytes) {
        setMessage(`Датотеката надминува ${previewFileSize}.`);
        return;
      }
      const { source, receipt } = attempt;
      const form = new FormData();
      form.set("file", file);
      form.set("receipt", receipt);
      form.set("hasHeader", String(source.hasHeader));
      form.set("phoneColumn", String(source.phoneColumn));
      if (source.format === "csv") form.set("delimiter", source.delimiter);
      else form.set("sheet", String(source.sheetIndex));
      try {
        const response = await registryRequest<PreviewResponse>(
          `${pathFor(organizationId)}/preview${source.format === "xlsx" ? "/xlsx" : ""}`,
          { method: "POST", body: form, signal: AbortSignal.timeout(35_000) },
        );
        if (!response.preview || !response.confirmation || response.confirmation.idempotencyKey !== attempt.idempotencyKey) throw new Error();
        setRenewed({
          format: response.format, preview: response.preview, confirmation: response.confirmation,
          sheet: response.format === "xlsx" ? response.sheet : null,
        });
      } catch (error) {
        setMessage(errorMessage(error));
      }
    });
  }

  return {
    attempt, file, operation, result, renewed, message, expired, check, save, renew,
    selectFile: setFile, clearRenewal: () => setRenewed(null), clearMessage: () => setMessage(""),
  };
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23", timeZone: "Europe/Skopje",
});

export function ImportTime({ value }: { value: string }) {
  const { day, month, year, hour, minute } = Object.fromEntries(
    timeFormat.formatToParts(new Date(value)).map(({ type, value }) => [type, value]),
  );
  return <time dateTime={value}>{day}.{month}.{year}, {hour}:{minute}</time>;
}

export function ExcludedCounts({ counts }: { counts: PhoneAnalysisCounts }) {
  return <>
    <Count label="Дупликати" value={counts.duplicateValid} />
    <Count label="Невалидни" value={counts.invalid} />
    <Count label="За проверка" value={counts.review} />
    <Count label="Празни телефонски полиња" value={counts.emptyPhone} />
    <Count label="Целосно празни записи" value={counts.excludedEmptyRecords} />
  </>;
}

export function Count({ label, value }: { label: string; value: number }) {
  return <div className="min-w-0 rounded-md bg-slate-950/60 p-2.5">
    <dt className="text-slate-300">{label}</dt>
    <dd className="font-semibold tabular-nums">{formatPreviewCount(value)}</dd>
  </div>;
}

export function ImportResult({ result }: { result: ContactImportResult }) {
  return <section role="status" className="space-y-3 rounded-lg border border-teal-300/40 bg-teal-950/40 p-4">
    <h2 className="text-lg font-semibold text-teal-200">Увозот е зачуван</h2>
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
      <Count label="Нови контакти" value={result.newContacts} />
      <Count label="Претходно постојни контакти" value={result.existingContacts} />
      <ExcludedCounts counts={result.counts} />
    </dl>
    <p className="wrap-anywhere text-sm text-slate-300">Увоз {result.importId} · <ImportTime value={result.createdAt} /></p>
  </section>;
}

export function ImportRecovery({ flow }: { flow: ReturnType<typeof useContactImport> }) {
  const { attempt, operation, file, message, expired } = flow;
  if (!attempt) return null;
  const needsRenewal = expired || Date.now() >= attempt.expiresAt;
  return <section aria-labelledby="import-recovery" aria-busy={operation !== null} className="min-w-0 space-y-3 rounded-lg border border-amber-300/40 bg-slate-950/60 p-4">
    <h2 id="import-recovery" className="text-lg font-semibold">Проверка на увозот</h2>
    <p role="status" className="text-sm text-slate-200">
      {operation === "saving" ? "Се зачувува увозот…" : operation === "checking" ? "Се проверува исходот…"
        : operation === "renewing" ? "Се обновува прегледот…" : message || unknownMessage}
    </p>
    {operation !== "saving" && (
      <>
        <p className="text-sm text-slate-300">
          Ако исходот сè уште се обработува, проверете повторно. За повторно испраќање изберете ја истата оригинална датотека.
          {needsRenewal && " Прегледот е истечен и треба да се обнови пред повторна потврда."}
        </p>
        <div className="space-y-2 text-sm">
          <input id="import-recovery-file" type="file" accept={`.${attempt.source.format}`} disabled={operation !== null}
            aria-describedby="import-recovery-filename" className="peer sr-only"
            onChange={(event) => flow.selectFile(event.target.files?.[0] ?? null)}
          />
          <label htmlFor="import-recovery-file"
            className={`inline-block cursor-pointer peer-disabled:opacity-60 peer-focus-visible:outline-2 peer-focus-visible:outline-teal-300 ${secondaryButton}`}>
            Избери оригинална датотека
          </label>
          <p id="import-recovery-filename" className="wrap-anywhere text-slate-300">{file?.name ?? "Нема избрана датотека."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={operation !== null} onClick={() => void flow.check()} className={primaryButton}>Провери исход</button>
          {needsRenewal
            ? <button type="button" disabled={operation !== null || !file} onClick={() => void flow.renew()} className={secondaryButton}>Обнови преглед</button>
            : <button type="button" disabled={operation !== null || !file} onClick={() => { if (file) void flow.save(file, attempt); }}
              className={secondaryButton}>Повтори зачувување</button>}
        </div>
      </>
    )}
  </section>;
}

export function ImportHistory({ organizationId, lastImportId }: { organizationId: string; lastImportId?: string }) {
  const [history, setHistory] = useState<ContactImportHistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    registryRequest<{ imports: ContactImportHistoryEntry[] }>(pathFor(organizationId), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    }).then(({ imports }) => {
      if (!controller.signal.aborted) { setHistory(imports); setError(""); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    });
    return () => controller.abort();
  }, [organizationId, lastImportId, refresh]);

  return <section className="min-w-0 space-y-3 border-t border-slate-700 pt-5" aria-labelledby="import-history-title">
    <h2 id="import-history-title" className="text-xl font-semibold">Последни увози</h2>
    {error && <div className="space-y-2"><RegistryError message={error} />
      <button type="button" onClick={() => setRefresh((value) => value + 1)} className={secondaryButton}>Обиди се повторно</button>
    </div>}
    {!history && !error && <p role="status" className="text-sm text-slate-300">Се вчитуваат увозите…</p>}
    {history?.length === 0 && <p className="text-sm text-slate-300">Сè уште нема завршени увози.</p>}
    {!!history?.length && <ul className="divide-y divide-slate-700 rounded-lg border border-slate-700">
      {history.map(({ importId, createdAt, format, newContacts, existingContacts }) => (
        <li key={importId} className="space-y-1 px-3 py-2.5 text-sm">
          <p className="font-medium"><ImportTime value={createdAt} /> · {format.toUpperCase()}</p>
          <p className="text-slate-200">Нови {formatPreviewCount(newContacts)} · Постојни {formatPreviewCount(existingContacts)}</p>
          <p className="wrap-anywhere text-xs text-slate-400">{importId}</p>
        </li>
      ))}
    </ul>}
  </section>;
}
