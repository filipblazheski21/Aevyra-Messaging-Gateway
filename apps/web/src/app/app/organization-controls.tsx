"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { formatPreviewCount, previewFileSize, previewLimits, xlsxLimits } from "../../import-preview.ts";
import type { CsvDelimiter, ImportPreview, ImportSource, PhoneAssessment, XlsxSheet } from "../../import-preview.ts";
import type { Organization, OrganizationKind, OrganizationPage } from "../../organizations.ts";
import { Count, ExcludedCounts, ImportHistory, ImportRecovery, ImportResult, useContactImport } from "./contact-import-controls.tsx";
import type { PreviewResponse } from "./contact-import-controls.tsx";
import { ContactList } from "./contact-list.tsx";
import { errorMessage, primaryButton, RegistryError, registryRequest, secondaryButton } from "./registry-ui.tsx";

const labels = {
  CLINIC: { section: "Клиники", add: "Додај клиника", empty: "Сè уште нема додадени клиники.", type: "Клиника" },
  MARKETING: { section: "Маркетинг на Aevyra", add: "Додај маркетинг база", empty: "Сè уште нема додадени маркетинг бази.", type: "Маркетинг база" },
} satisfies Record<OrganizationKind, { section: string; add: string; empty: string; type: string }>;

function saveOrganization(path: string, method: "POST" | "PATCH", data: { name: string; kind?: OrganizationKind }) {
  return registryRequest<Organization>(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
}
function OrganizationNameForm({ initialName = "", onSave, onCancel }: {
  initialName?: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await onSave(name);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4" aria-busy={pending}>
      <label className="block space-y-2">
        <span className="block text-sm font-medium">Име</span>
        <input name="name" defaultValue={initialName} required autoFocus disabled={pending}
          className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-300" />
      </label>
      {error && <RegistryError message={error} />}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Се зачувува…" : "Зачувај"}</button>
        <button type="button" disabled={pending} onClick={onCancel} className={secondaryButton}>Откажи</button>
      </div>
    </form>
  );
}

export function OrganizationSection({ kind }: { kind: OrganizationKind }) {
  const [adding, setAdding] = useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<OrganizationPage | null>(null);
  const [error, setError] = useState("");
  const cursor = cursors[cursors.length - 1];
  const text = labels[kind];

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ kind });
    if (cursor) params.set("cursor", cursor);
    registryRequest<OrganizationPage>(`?${params}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setPage(result); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [kind, cursor, refresh]);

  function retry() {
    setPage(null);
    setError("");
    setRefresh((value) => value + 1);
  }

  async function add(name: string) {
    await saveOrganization("", "POST", { kind, name });
    setAdding(false);
    setCursors([null]);
    retry();
  }

  function changePage(next: (string | null)[]) {
    setPage(null);
    setCursors(next);
  }

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5" aria-labelledby={`${kind}-title`}>
      <h2 id={`${kind}-title`} className="text-xl font-semibold">{text.section}</h2>
      {adding ? <OrganizationNameForm onSave={add} onCancel={() => setAdding(false)} /> : (
        <button type="button" onClick={() => setAdding(true)} className={primaryButton}>{text.add}</button>
      )}
      {error && <div className="space-y-3"><RegistryError message={error} /><button type="button" onClick={retry} className={secondaryButton}>Обиди се повторно</button></div>}
      {!page && !error && <p role="status" className="text-sm text-slate-300">Се вчитуваат записите…</p>}
      {page?.items.length === 0 && <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-300">{text.empty}</p>}
      {!!page?.items.length && (
        <ul className="divide-y divide-slate-700 rounded-lg border border-slate-700">
          {page.items.map((item) => (
            <li key={item.id}>
              <Link href={`/app/organizations/${item.id}`} className="block wrap-break-word px-4 py-3 font-medium text-teal-200 hover:bg-slate-800 hover:underline focus-visible:outline-2 focus-visible:outline-teal-300">
                {item.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page && (cursors.length > 1 || page.nextCursor) && (
        <nav aria-label={`Страници за ${text.section}`} className="flex flex-wrap gap-2">
          <button type="button" disabled={cursors.length === 1} onClick={() => changePage(cursors.slice(0, -1))} className={secondaryButton}>Претходна</button>
          <button type="button" disabled={!page.nextCursor} onClick={() => changePage([...cursors, page.nextCursor])} className={secondaryButton}>Следна</button>
        </nav>
      )}
    </section>
  );
}

export function OrganizationDetails({ initial, operatorId }: { initial: Organization; operatorId: string }) {
  const [record, setRecord] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const flow = useContactImport(record.id, operatorId);
  const { renewed } = flow;

  async function rename(name: string) {
    setRecord(await saveOrganization(`/${record.id}`, "PATCH", { name }));
    setEditing(false);
  }

  return (
    <section className="space-y-5 rounded-xl border border-slate-700 bg-slate-900 p-6" aria-labelledby="organization-title">
      <div>
        <p className="text-sm font-semibold text-teal-300">{labels[record.kind].type}</p>
        <h1 id="organization-title" className="mt-2 wrap-break-word text-3xl font-semibold tracking-tight">{record.name}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {!editing && <button type="button" onClick={() => setEditing(true)} className={primaryButton}>Измени име</button>}
        <button type="button" disabled={!!flow.attempt} onClick={() => { flow.clearMessage(); setPreviewOpen(!previewOpen); }} aria-expanded={previewOpen && !flow.attempt}
          aria-controls={previewOpen && !flow.attempt ? "file-preview" : undefined} className={secondaryButton}>
          Преглед на датотека
        </button>
      </div>
      {editing && <OrganizationNameForm initialName={record.name} onSave={rename} onCancel={() => setEditing(false)} />}
      <ContactList organization={record} operatorId={operatorId} confirmedImportId={flow.result?.importId} />
      {previewOpen && !flow.attempt && <FilePreviewForm organization={record} onConfirm={(file, confirmation) => {
        setPreviewOpen(false);
        void flow.save(file, confirmation);
      }} />}
      {renewed && flow.file ? <RenewedPreview organization={record} renewed={renewed}
        onConfirm={() => { if (flow.file) void flow.save(flow.file, renewed.confirmation); }}
        onCancel={flow.clearRenewal} /> : <ImportRecovery flow={flow} />}
      {!flow.attempt && flow.message && <RegistryError message={flow.message} />}
      {flow.result && <ImportResult result={flow.result} />}
      <ImportHistory organizationId={record.id} lastImportId={flow.result?.importId} />
    </section>
  );
}

function RenewedPreview({ organization, renewed, onConfirm, onCancel }: {
  organization: Organization; renewed: NonNullable<ReturnType<typeof useContactImport>["renewed"]>;
  onConfirm: () => void; onCancel: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  return reviewing ? (
    <ConfirmationReview organization={organization} source={renewed.confirmation.source} preview={renewed.preview}
      sheet={renewed.sheet} onConfirm={onConfirm} onBack={() => setReviewing(false)} />
  ) : (
    <section aria-labelledby="renewed-preview-title" className="space-y-3 border-t border-slate-700 pt-5">
      <h2 id="renewed-preview-title" className="text-xl font-semibold">Обновен преглед</h2>
      {renewed.sheet && <p className="wrap-anywhere text-sm text-slate-300">Лист „{renewed.sheet.name}“</p>}
      <PhonePreviewResults preview={renewed.preview} sourceLabel={renewed.format === "xlsx" ? "Excel ред" : "CSV запис"} />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setReviewing(true)} className={primaryButton}>Зачувај валидни контакти</button>
        <button type="button" onClick={onCancel} className={secondaryButton}>Назад кон проверката на исходот</button>
      </div>
    </section>
  );
}

function ConfirmationReview({ organization, source, preview, sheet, onConfirm, onBack }: {
  organization: Organization; source: ImportSource; preview: ImportPreview; sheet?: XlsxSheet | null;
  onConfirm: () => void; onBack: () => void;
}) {
  const counts = preview.analysis?.counts;
  if (!counts?.uniqueValid) return null;
  const columnName = preview.columns.find(({ index }) => index === source.phoneColumn)?.name;
  const delimiterNames = { comma: "запирка", semicolon: "точка-запирка", tab: "табулатор" };
  return (
    <section aria-labelledby="confirm-import-title" className="min-w-0 space-y-4 rounded-lg border border-teal-300/40 bg-slate-950/60 p-4">
      <h2 id="confirm-import-title" className="text-lg font-semibold">Потврда за зачувување</h2>
      <div className="space-y-1 text-sm text-slate-200">
        <p className="wrap-anywhere font-medium">{organization.name} · {labels[organization.kind].type}</p>
        <p className="wrap-anywhere">{source.format === "xlsx" ? `XLSX · Лист „${sheet?.name ?? source.sheetIndex + 1}“`
          : `CSV · Разделувач ${delimiterNames[source.delimiter]}`}</p>
        <p className="wrap-anywhere">Телефонска колона {source.phoneColumn + 1}{columnName && ` · ${columnName}`}</p>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <Count label="Вкупни записи" value={preview.totalRecords} />
        <Count label="Единствени валидни контакти" value={counts.uniqueValid} />
      </dl>
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-200">Записи што ќе се исклучат</h3>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3"><ExcludedCounts counts={counts} /></dl>
      </div>
      <p className="text-sm text-slate-300">
        Постојните контакти во оваа организација ќе се користат повторно. Со зачувувањето не се доделува дозвола за контакт.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} className={primaryButton}>Потврди зачувување</button>
        <button type="button" onClick={onBack} className={secondaryButton}>Назад кон прегледот</button>
      </div>
    </section>
  );
}

function FilePreviewForm({ organization, onConfirm }: {
  organization: Organization; onConfirm: (file: File, confirmation: NonNullable<PreviewResponse["confirmation"]>) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [delimiter, setDelimiter] = useState<CsvDelimiter>("comma");
  const [hasHeader, setHasHeader] = useState(true);
  const [phoneColumn, setPhoneColumn] = useState("");
  const [columns, setColumns] = useState<ImportPreview["columns"] | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirmation, setConfirmation] = useState<PreviewResponse["confirmation"]>();
  const [reviewing, setReviewing] = useState(false);
  const [sheets, setSheets] = useState<XlsxSheet[]>([]);
  const [sheet, setSheet] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef<AbortController | null>(null);
  const filename = file?.name.toLowerCase();
  const isXlsx = filename?.endsWith(".xlsx") ?? false;
  const selectedSheet = sheets.find(({ index }) => String(index) === sheet);

  useEffect(() => () => inFlight.current?.abort(), []);

  function clearPreview() {
    inFlight.current?.abort();
    inFlight.current = null;
    setPending(false);
    setPreview(null);
    setConfirmation(undefined);
    setReviewing(false);
    setError("");
  }

  function changeSettings() {
    clearPreview();
    setColumns(null);
    setPhoneColumn("");
  }

  async function loadPreview(column: string, sheetIndex: string) {
    clearPreview();
    if (!file || (!isXlsx && !filename?.endsWith(".csv"))) {
      setError("Изберете CSV (.csv) или Excel (.xlsx) датотека.");
      return;
    }
    if (file.size > previewLimits.fileBytes) {
      setError(`Датотеката надминува ${previewFileSize}.`);
      return;
    }

    const form = new FormData();
    form.set("file", file);
    if (!isXlsx) form.set("delimiter", delimiter);
    if (isXlsx && sheetIndex !== "") form.set("sheet", sheetIndex);
    form.set("hasHeader", String(hasHeader));
    if (column !== "") form.set("phoneColumn", column);
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    try {
      const path = `/${organization.id}/imports/preview${isXlsx ? "/xlsx" : ""}`;
      const result = await registryRequest<PreviewResponse>(path, {
        method: "POST", body: form, signal: controller.signal,
      });
      if (inFlight.current !== controller) return;
      if ("sheets" in result) setSheets(result.sheets);
      if (column === "") setColumns(result.preview?.columns ?? null);
      else {
        setPreview(result.preview);
        setConfirmation(result.confirmation);
      }
    } catch (failure) {
      if (inFlight.current === controller) setError(errorMessage(failure));
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }

  const selectStyle = "w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300";
  if (reviewing && file && preview && confirmation) {
    return <div id="file-preview"><ConfirmationReview organization={organization} source={confirmation.source} preview={preview}
      sheet={selectedSheet} onConfirm={() => onConfirm(file, confirmation)} onBack={() => setReviewing(false)} /></div>;
  }
  return (
    <section id="file-preview" aria-labelledby="file-preview-title" className="min-w-0 space-y-4 border-t border-slate-700 pt-5">
      <h2 id="file-preview-title" className="text-xl font-semibold">Преглед на датотека</h2>
      <p className="rounded-lg border border-teal-300/30 bg-teal-950/40 p-3 text-sm text-teal-100">
        Ова е проверка на форматот. Контактите не се зачувани. Не се проверени активноста на броевите, достапноста на каналите или дозволата за контакт.
      </p>
      <form className="space-y-4" noValidate onSubmit={(event) => {
        event.preventDefault();
        changeSettings();
        void loadPreview("", sheet);
      }}>
        <div className="space-y-2">
          <p id="file-limits" className="text-sm text-slate-300">
            CSV (.csv) со UTF-8 кодирање или Excel (.xlsx). До {previewFileSize}, {formatPreviewCount(previewLimits.records)} податочни записи,
            {" "}{previewLimits.columns} колони и {formatPreviewCount(previewLimits.fieldCharacters)} знаци во поле.
            {" "}Се прикажуваат најмногу {previewLimits.samples} примероци.
          </p>
          <input id="preview-file" type="file" accept=".csv,.xlsx" aria-describedby="file-limits preview-filename"
            className="peer sr-only" onChange={(event) => {
              changeSettings();
              setSheets([]);
              setSheet("");
              setFile(event.target.files?.[0] ?? null);
            }} />
          <label htmlFor="preview-file" className={`inline-block cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-teal-300 ${secondaryButton}`}>
            Избери датотека
          </label>
          <p id="preview-filename" className="wrap-anywhere text-sm text-slate-300">{file?.name ?? "Нема избрана датотека."}</p>
        </div>
        {!isXlsx && <label className="block space-y-2 text-sm">
          <span className="block font-medium">Разделувач</span>
          <select value={delimiter} onChange={(event) => {
            changeSettings();
            setDelimiter(event.target.value as CsvDelimiter);
          }} className={selectStyle}>
            <option value="comma">Запирка (,)</option>
            <option value="semicolon">Точка-запирка (;)</option>
            <option value="tab">Табулатор</option>
          </select>
        </label>}
        {isXlsx && <p className="text-sm text-slate-300">
          До {xlsxLimits.sheets} работни листови. Скриените и филтрираните редови во избраниот лист се вклучуваат.
        </p>}
        {isXlsx && sheets.length > 0 && (
          <label className="block space-y-2 text-sm">
            <span className="block font-medium">Работен лист</span>
            <select value={sheet} className={selectStyle} onChange={(event) => {
              const index = event.target.value;
              changeSettings();
              setSheet(index);
              if (index !== "") void loadPreview("", index);
            }}>
              <option value="">Изберете лист</option>
              {sheets.map(({ index, name, hidden }) => (
                <option key={index} value={index}>{name}{hidden ? " (скриен)" : ""}</option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={hasHeader} className="mt-0.5 accent-teal-300" onChange={(event) => {
            changeSettings();
            setHasHeader(event.target.checked);
          }} />
          Првиот ред содржи имиња на колони
        </label>
        <button type="submit" disabled={pending} className={primaryButton}>
          {isXlsx && sheet === "" ? "Прочитај листови" : "Прочитај колони"}
        </button>
      </form>
      {columns && (
        <label className="block space-y-2 text-sm">
          <span className="block font-medium">Телефонска колона</span>
          <select value={phoneColumn} className={selectStyle} onChange={(event) => {
            const column = event.target.value;
            setPhoneColumn(column);
            if (column === "") clearPreview();
            else void loadPreview(column, sheet);
          }}>
            <option value="">Изберете колона</option>
            {columns.map(({ index, name }) => (
              <option key={index} value={index}>
                Колона {index + 1}{name === "" ? " — без име" : name && ` — ${name.slice(0, 80)}${name.length > 80 ? "…" : ""}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {pending && <p role="status" className="text-sm text-slate-300">Се чита датотеката…</p>}
      {error && <RegistryError message={error} />}
      {preview && (
        <div className="space-y-3">
          {selectedSheet && <p className="wrap-anywhere text-sm text-slate-300">Лист „{selectedSheet.name}“{selectedSheet.hidden ? " (скриен)" : ""}</p>}
          {confirmation && <button type="button" className={primaryButton} onClick={() => setReviewing(true)}>Зачувај валидни контакти</button>}
          <PhonePreviewResults preview={preview} sourceLabel={isXlsx ? "Excel ред" : "CSV запис"} />
        </div>
      )}
    </section>
  );
}

const phoneStatuses = {
  VALID: { label: "Валиден формат", style: "bg-teal-950 text-teal-200" },
  INVALID: { label: "Невалиден број", style: "bg-rose-950 text-rose-200" },
  REVIEW: { label: "За проверка", style: "bg-amber-950 text-amber-200" },
  EMPTY: { label: "Празно поле", style: "bg-slate-800 text-slate-200" },
} satisfies Record<PhoneAssessment["status"], { label: string; style: string }>;

const phoneTypes = {
  FIXED_LINE: "Фиксен", MOBILE: "Мобилен", FIXED_LINE_OR_MOBILE: "Фиксен или мобилен",
  PREMIUM_RATE: "Со посебна тарифа", TOLL_FREE: "Бесплатен за повикувачот", SHARED_COST: "Со поделен трошок",
  VOIP: "Интернет телефонија", PERSONAL_NUMBER: "Личен број", PAGER: "Пејџер",
  UAN: "Универзален пристап", VOICEMAIL: "Гласовно сандаче",
} satisfies Record<NonNullable<Extract<PhoneAssessment, { status: "VALID" }>["phoneType"]>, string>;

const regionNames = Intl.DisplayNames.supportedLocalesOf("mk").length
  ? new Intl.DisplayNames("mk", { type: "region", fallback: "code" })
  : null;

function PhonePreviewResults({ preview, sourceLabel }: { preview: ImportPreview; sourceLabel: "Excel ред" | "CSV запис" }) {
  if (!preview.analysis) return null;
  const { counts } = preview.analysis;
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-300">
        <span>Вкупно податочни записи <strong className="text-slate-100">{formatPreviewCount(preview.totalRecords)}</strong></span>
        <span>Прикажани примероци <strong className="text-slate-100">{formatPreviewCount(preview.samples.length)}</strong></span>
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3" aria-label="Резултати за целата колона">
        {([
          ["Исклучени празни записи", counts.excludedEmptyRecords],
          ["Празни телефонски полиња", counts.emptyPhone],
          ["Невалидни", counts.invalid],
          ["За проверка", counts.review],
          ["Единствени валидни", counts.uniqueValid],
          ["Дупликатни валидни", counts.duplicateValid],
        ] as const).map(([label, count]) => (
          <div key={label} className="rounded-lg bg-slate-950 p-3">
            <dt className="text-slate-300">{label}</dt>
            <dd className="font-semibold">{formatPreviewCount(count)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-slate-300">Бројачите се за целата избрана колона. Целосно празните записи се бројат одделно од празните телефонски полиња.</p>
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">Анализирани примероци од телефонската колона</caption>
        <thead className="bg-slate-950">
          <tr><th scope="col" className="w-20 p-2 sm:w-24">{sourceLabel}</th><th scope="col" className="p-2">Телефон и исход</th></tr>
        </thead>
        <tbody>
          {preview.samples.map(({ recordNumber, value, phone }) => {
            const status = phoneStatuses[phone.status];
            return (
              <tr key={recordNumber} className="border-b border-slate-700 align-top">
                <td className="p-2 tabular-nums">{recordNumber}</td>
                <td className="p-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs text-slate-400">Оригинал</p>
                      <p className="wrap-anywhere whitespace-pre-wrap">{value === "" ? "—" : value}</p>
                      {phone.status === "VALID" && (
                        <div>
                          <p className="text-xs text-slate-400">Нормализиран број (E.164)</p>
                          <p className="wrap-anywhere font-medium">{phone.normalizedPhone}</p>
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap gap-1.5">
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${status.style}`}>{status.label}</span>
                        {phone.duplicate && <span className="rounded bg-slate-700 px-2 py-0.5 text-xs font-semibold">Дупликат</span>}
                      </div>
                      <p className="text-xs text-slate-300">{phone.reason}</p>
                      {phone.status === "VALID" && (phone.country || phone.phoneType) && (
                        <p className="text-xs text-slate-300">
                          {[phone.country && (regionNames?.of(phone.country) ?? phone.country), phone.phoneType && phoneTypes[phone.phoneType]].filter(Boolean).join(" · ")}
                        </p>
                      )}
                      {phone.duplicate && <p className="text-xs text-slate-300">Прво појавување · {sourceLabel} {phone.firstRecordNumber}</p>}
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
          {preview.samples.length === 0 && <tr><td colSpan={2} className="p-2 text-slate-300">Нема примероци за приказ.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

