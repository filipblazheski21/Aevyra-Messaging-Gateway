"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  contactBasisChannelLabels,
  contactBasisChannels,
  contactBasisPurposeForOrganization,
  contactBasisPurposeLabels,
  contactBasisStatusLabels,
  contactBasisTypeLabels,
  contactBasisTypes,
} from "../../contact-bases.ts";
import type {
  ContactBasisChannel,
  ContactBasisCurrentState,
  ContactBasisType,
} from "../../contact-bases.ts";
import {
  clearPendingContactBasisOperation,
  readPendingContactBasisOperation,
  skopjeLocalDateTimeToIso,
  storePendingContactBasisOperation,
  validateContactBasisWriteResult,
} from "../../contact-basis-write.ts";
import type {
  ContactBasisOperationScope,
  ContactBasisWriteRequest,
  PendingContactBasisOperation,
} from "../../contact-basis-write.ts";
import type { ContactListItem } from "../../contacts.ts";
import type { Organization } from "../../organizations.ts";
import {
  errorMessage,
  primaryButton,
  RegistryError,
  RegistryRequestError,
  registryRequest,
  secondaryButton,
} from "./registry-ui.tsx";

const contactBasisReadTimeoutMs = 10_000;
const contactBasisWriteTimeoutMs = 20_000;
const skopjeDateTime = new Intl.DateTimeFormat("mk-MK-u-nu-latn", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Skopje",
});

function formatSkopjeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Невалиден датум";
  const parts: Record<string, string> = {};
  for (const part of skopjeDateTime.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute}:${parts.second}`;
}

type Draft = {
  eventType: "RECORD";
  basisType: ContactBasisType;
  reference: string;
  localExpiry: string;
  expiresAt: string | null;
} | {
  eventType: "WITHDRAW";
  reference: string;
};

function operationLabel(operation: PendingContactBasisOperation) {
  return operation.request.eventType === "RECORD" ? "евидентирање основа" : "повлекување основа";
}

function BasisDetails({ current }: { current: ContactBasisCurrentState }) {
  const event = current.latestEvent;
  return (
    <div className="space-y-4" data-contact-basis-state={current.status}>
      <div className="rounded-lg border border-slate-600 bg-slate-950/50 p-4">
        <p className="text-sm text-slate-400">Состојба</p>
        <p className="mt-1 text-lg font-semibold text-teal-100">{contactBasisStatusLabels[current.status]}</p>
      </div>
      {current.suppression && (
        <div className="rounded-lg border border-rose-400/50 bg-rose-950/35 p-4" role="status">
          <p className="font-semibold text-rose-200">Не контактирај</p>
          <p className="mt-1 text-sm text-slate-300">Оваа ознака е независна од евидентираната основа.</p>
        </div>
      )}
      {event && (
        <dl className="grid gap-3 rounded-lg border border-slate-700 p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-400">Последен настан</dt><dd>{event.eventType === "RECORD" ? "Евидентирање" : "Повлекување"}</dd></div>
          {event.eventType === "RECORD" && event.basisType && (
            <div><dt className="text-slate-400">Вид на основа</dt><dd>{contactBasisTypeLabels[event.basisType]}</dd></div>
          )}
          <div><dt className="text-slate-400">Време на евидентирање</dt><dd>{formatSkopjeDate(event.recordedAt)}</dd></div>
          {event.reference && (
            <div className="sm:col-span-2"><dt className="text-slate-400">Референца</dt><dd className="wrap-anywhere whitespace-pre-wrap">{event.reference}</dd></div>
          )}
          {event.eventType === "RECORD" && (
            <div className="sm:col-span-2"><dt className="text-slate-400">Рок на важност</dt><dd>{event.expiresAt ? formatSkopjeDate(event.expiresAt) : "Без наведен рок"}</dd></div>
          )}
        </dl>
      )}
    </div>
  );
}

export function ContactBasisDialog({ organization, contact, operatorId, onClose }: {
  organization: Organization;
  contact: ContactListItem;
  operatorId: string;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState<ContactBasisChannel>("SMS");
  const [current, setCurrent] = useState<ContactBasisCurrentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<"RECORD" | "WITHDRAW" | null>(null);
  const [basisType, setBasisType] = useState<"" | ContactBasisType>("");
  const [reference, setReference] = useState("");
  const [localExpiry, setLocalExpiry] = useState("");
  const [review, setReview] = useState<Draft | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingContactBasisOperation | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [writeMessage, setWriteMessage] = useState("");
  const requestSequence = useRef(0);
  const submission = useRef(false);
  const mounted = useRef(true);
  const writeController = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const purpose = contactBasisPurposeForOrganization[organization.kind];
  const scope: ContactBasisOperationScope = {
    operatorId,
    organizationId: organization.id,
    contactId: contact.id,
    purpose,
    channel,
  };

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      writeController.current?.abort();
      writeController.current = null;
      submission.current = false;
    };
  }, []);

  useEffect(() => {
    setRecoveryReady(false);
    setRecoveryError("");
    setPendingOperation(null);
    const saved = readPendingContactBasisOperation(() => window.sessionStorage, {
      operatorId,
      organizationId: organization.id,
      contactId: contact.id,
      purpose,
      channel,
    });
    if (saved.status === "VALID") setPendingOperation(saved.operation);
    else if (saved.status === "INVALID" || saved.status === "UNAVAILABLE") setRecoveryError(saved.message);
    setRecoveryReady(true);
  }, [channel, contact.id, operatorId, organization.id, purpose]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, contactBasisReadTimeoutMs);
    const params = new URLSearchParams({ purpose, channel });
    setCurrent(null);
    setLoading(true);
    setError("");
    registryRequest<ContactBasisCurrentState>(
      `/${organization.id}/contacts/${contact.id}/basis?${params}`,
      { signal: controller.signal },
    ).then((result) => {
      if (!controller.signal.aborted && requestSequence.current === sequence) setCurrent(result);
    }).catch((failure: unknown) => {
      if (requestSequence.current === sequence) {
        setError(timedOut ? "Читањето на основата траеше предолго. Обидете се повторно." : errorMessage(failure));
      }
    }).finally(() => {
      window.clearTimeout(timeout);
      if (requestSequence.current === sequence) setLoading(false);
    });
    return () => {
      window.clearTimeout(timeout);
      requestSequence.current++;
      controller.abort();
    };
  }, [channel, contact.id, organization.id, purpose, retry]);

  function keyboardNavigation(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((item) => !item.hidden);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function changeChannel(value: ContactBasisChannel) {
    requestSequence.current++;
    setCurrent(null);
    setError("");
    setLoading(true);
    setMode(null);
    setReview(null);
    setBasisType("");
    setReference("");
    setLocalExpiry("");
    setWriteError("");
    setWriteMessage("");
    setPendingOperation(null);
    setRecoveryReady(false);
    setRecoveryError("");
    setChannel(value);
  }

  function startMode(value: "RECORD" | "WITHDRAW") {
    setMode(value);
    setReview(null);
    setBasisType("");
    setReference("");
    setLocalExpiry("");
    setWriteError("");
    setWriteMessage("");
  }

  function cancelDraft() {
    setMode(null);
    setReview(null);
    setBasisType("");
    setReference("");
    setLocalExpiry("");
    setWriteError("");
  }

  function reviewDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWriteError("");
    setWriteMessage("");
    const cleanReference = reference.trim();
    if (mode === "RECORD") {
      if (!basisType) {
        setWriteError("Избери вид на основа.");
        return;
      }
      if (!cleanReference) {
        setWriteError("Внеси кратка референца за доказот.");
        return;
      }
      let expiresAt: string | null = null;
      if (localExpiry) {
        const converted = skopjeLocalDateTimeToIso(localExpiry);
        if (!converted.ok) {
          setWriteError(converted.message);
          return;
        }
        if (Date.parse(converted.iso) <= Date.now()) {
          setWriteError("Рокот мора да биде во иднина.");
          return;
        }
        expiresAt = converted.iso;
      }
      setReview({ eventType: "RECORD", basisType, reference: cleanReference, localExpiry, expiresAt });
      return;
    }
    if (mode === "WITHDRAW") setReview({ eventType: "WITHDRAW", reference: cleanReference });
  }

  async function sendOperation(operation: PendingContactBasisOperation) {
    if (submission.current) return;
    submission.current = true;
    const controller = new AbortController();
    writeController.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, contactBasisWriteTimeoutMs);
    setSubmitting(true);
    setWriteError("");
    setWriteMessage("");
    try {
      const response = await registryRequest<unknown>(
        `/${operation.organizationId}/contacts/${operation.contactId}/basis`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation.request),
          signal: controller.signal,
        },
      );
      const result = validateContactBasisWriteResult(response, operation);
      if (!result) throw new Error("INVALID_SUCCESS_RESPONSE");
      if (!mounted.current) return;
      const cleared = clearPendingContactBasisOperation(() => window.sessionStorage, operation);
      if (!cleared.ok) setRecoveryError(cleared.message);
      setPendingOperation(null);
      setCurrent(result.current);
      setMode(null);
      setReview(null);
      setWriteMessage(result.outcome === "APPENDED"
        ? "Операцијата е успешно запишана."
        : "Истата операција е потврдена без нов дупликат.");
    } catch (failure) {
      if (!mounted.current) return;
      const code = failure instanceof RegistryRequestError ? failure.code : undefined;
      const finalCodes = new Set([
        "INVALID_REQUEST", "PURPOSE_NOT_ALLOWED", "ORGANIZATION_NOT_FOUND", "CONTACT_NOT_FOUND",
        "REVISION_CONFLICT", "BODY_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE",
      ]);
      if (!code || code === "OUTCOME_UNKNOWN" || code === "TEMPORARILY_UNAVAILABLE"
          || code === "AUTH_REQUIRED" || code === "ORIGIN_DENIED" || code === "IDEMPOTENCY_CONFLICT") {
        if (code === "IDEMPOTENCY_CONFLICT") {
          setWriteError("Клучот за повторување е во конфликт. Оригиналната неизвесна операција е зачувана и не е заменета.");
        }
        setPendingOperation(operation);
        setWriteMessage(timedOut
          ? "Истече рокот за одговор. Исходот е неизвесен; записот можеби постои. Повтори ја истата операција со зачуваниот клуч."
          : "Исходот е неизвесен; записот можеби постои. Повтори ја истата операција со зачуваниот клуч.");
      } else {
        if (!finalCodes.has(code)) {
          setPendingOperation(operation);
          setWriteMessage("Одговорот не докажува конечен исход. Оригиналната операција е зачувана за рачно повторување.");
          return;
        }
        const cleared = clearPendingContactBasisOperation(() => window.sessionStorage, operation);
        if (!cleared.ok) setRecoveryError(cleared.message);
        setPendingOperation(null);
        setReview(null);
        setMode(null);
        if (code === "REVISION_CONFLICT") {
          setWriteError("Состојбата е изменета. Ја освежуваме; прегледај и потврди нова операција.");
          setRetry((value) => value + 1);
        } else if (code === "IDEMPOTENCY_CONFLICT") {
          setWriteError("Клучот за повторување е во конфликт. Операцијата не е заменета; прегледај ја пред нова потврда.");
        } else {
          setWriteError(errorMessage(failure));
        }
      }
    } finally {
      window.clearTimeout(timeout);
      if (writeController.current === controller) writeController.current = null;
      submission.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  function confirmDraft() {
    if (!review || !current || pendingOperation || !recoveryReady || recoveryError || submission.current) return;
    const common = {
      purpose,
      channel,
      expectedRevision: current.revision,
      idempotencyKey: crypto.randomUUID(),
    };
    const request: ContactBasisWriteRequest = review.eventType === "RECORD"
      ? { ...common, eventType: "RECORD", basisType: review.basisType, reference: review.reference, expiresAt: review.expiresAt }
      : { ...common, eventType: "WITHDRAW", ...(review.reference ? { reference: review.reference } : {}) };
    const operation: PendingContactBasisOperation = {
      version: 1,
      ...scope,
      createdAt: new Date().toISOString(),
      request,
    };
    const stored = storePendingContactBasisOperation(() => window.sessionStorage, operation);
    if (!stored.ok) {
      setRecoveryError(stored.message);
      setWriteError("Операцијата не може безбедно да се зачува во ова јазиче, па не е испратена.");
      return;
    }
    setPendingOperation(operation);
    void sendOperation(operation);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-3 sm:items-center sm:p-6" role="presentation">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="contact-basis-title"
        aria-describedby="contact-basis-explanation" onKeyDown={keyboardNavigation}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="wrap-anywhere text-sm font-semibold text-teal-300">{organization.name}</p>
            <h2 id="contact-basis-title" className="mt-1 wrap-anywhere text-xl font-semibold">Основа за контакт — {contact.normalizedPhone}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className={secondaryButton} aria-label="Затвори преглед на основата">Затвори</button>
        </div>
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 rounded-lg border border-slate-700 p-4 text-sm sm:grid-cols-2">
            <div><p className="text-slate-400">Организација</p><p className="wrap-anywhere">{organization.name}</p></div>
            <div><p className="text-slate-400">Телефон</p><p className="wrap-anywhere">{contact.normalizedPhone}</p></div>
            <div className="sm:col-span-2"><p className="text-slate-400">Намена</p><p>{contactBasisPurposeLabels[purpose]}</p></div>
          </div>
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Канал</span>
            <select value={channel} disabled={submitting} onChange={(event) => changeChannel(event.target.value as ContactBasisChannel)}
              className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300">
              {contactBasisChannels.map((value) => <option key={value} value={value}>{contactBasisChannelLabels[value]}</option>)}
            </select>
          </label>
          {loading && <p role="status" className="rounded-lg border border-slate-700 p-4 text-sm text-slate-300">Се вчитува основата за избраниот канал.</p>}
          {!loading && error && (
            <div className="space-y-3"><RegistryError message={error} /><button type="button" onClick={() => setRetry((value) => value + 1)} className={secondaryButton}>Обиди се повторно</button></div>
          )}
          {!loading && !error && current && <BasisDetails current={current} />}
          {recoveryReady && recoveryError && <RegistryError message={`${recoveryError} Нова операција во овој опсег е блокирана.`} />}
          {!loading && !error && current && pendingOperation && (
            <section aria-labelledby="basis-recovery-title" className="space-y-3 rounded-lg border border-amber-300/50 bg-amber-950/25 p-4">
              <h3 id="basis-recovery-title" className="font-semibold text-amber-100">Непотврдена операција</h3>
              <p className="text-sm text-slate-200">
                Зачувано е {operationLabel(pendingOperation)} за овој оператор, контакт, намена и канал.
                Обичното освежување ја покажува тековната состојба, но не го докажува исходот на оваа операција.
              </p>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-400">Операција</dt><dd>{pendingOperation.request.eventType === "RECORD" ? "Евидентирање" : "Повлекување"}</dd></div>
                <div><dt className="text-slate-400">Очекувана ревизија</dt><dd>{pendingOperation.request.expectedRevision}</dd></div>
                {pendingOperation.request.reference && <div className="sm:col-span-2"><dt className="text-slate-400">Референца</dt><dd className="wrap-anywhere whitespace-pre-wrap">{pendingOperation.request.reference}</dd></div>}
              </dl>
              <button type="button" disabled={submitting || !!recoveryError} onClick={() => void sendOperation(pendingOperation)} className={primaryButton}>
                {submitting ? "Се повторува..." : "Повтори ја истата операција"}
              </button>
            </section>
          )}
          {!loading && !error && current && recoveryReady && !recoveryError && !pendingOperation && !mode && (
            <div className="flex flex-wrap gap-2 border-t border-slate-700 pt-4">
              <button type="button" onClick={() => startMode("RECORD")} className={primaryButton}>Евидентирај основа</button>
              <button type="button" onClick={() => startMode("WITHDRAW")} className={secondaryButton}>Повлечи основа</button>
            </div>
          )}
          {!loading && !error && current && recoveryReady && !recoveryError && !pendingOperation && mode && !review && (
            <form onSubmit={reviewDraft} noValidate className="space-y-4 rounded-lg border border-slate-700 bg-slate-950/35 p-4">
              <h3 className="font-semibold">{mode === "RECORD" ? "Евидентирај основа" : "Повлечи основа"}</h3>
              {mode === "RECORD" && <>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">Вид на основа</span>
                  <select value={basisType} onChange={(event) => setBasisType(event.target.value as "" | ContactBasisType)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300">
                    <option value="">Избери вид</option>
                    {contactBasisTypes.map((value) => <option key={value} value={value}>{contactBasisTypeLabels[value]}</option>)}
                  </select>
                </label>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">Референца на доказ</span>
                  <input value={reference} maxLength={250} required onChange={(event) => setReference(event.target.value)}
                    aria-describedby="basis-reference-help" className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300" />
                  <span id="basis-reference-help" className="block text-xs text-slate-400">Краток идентификатор или ознака; не внесувај медицински податоци.</span>
                </label>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">Рок на важност (опционално)</span>
                  <input type="datetime-local" value={localExpiry} step="60" onChange={(event) => setLocalExpiry(event.target.value)}
                    aria-describedby="basis-expiry-help" className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300" />
                  <span id="basis-expiry-help" className="block text-xs text-slate-400">Датум и време во Europe/Skopje. Празно значи без рок.</span>
                </label>
              </>}
              {mode === "WITHDRAW" && <>
                <p className="text-sm text-slate-200">Повлекувањето важи само за избраната намена и канал и е дозволено и без позитивна основа.</p>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">Референца (опционално)</span>
                  <input value={reference} maxLength={250} onChange={(event) => setReference(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300" />
                </label>
              </>}
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={primaryButton}>Прегледај</button>
                <button type="button" onClick={cancelDraft} className={secondaryButton}>Откажи</button>
              </div>
            </form>
          )}
          {!loading && !error && current && recoveryReady && !recoveryError && !pendingOperation && review && (
            <section aria-labelledby="basis-confirm-title" className="space-y-4 rounded-lg border border-amber-400/40 bg-amber-950/20 p-4">
              <h3 id="basis-confirm-title" className="font-semibold">Преглед пред потврда</h3>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-400">Организација</dt><dd className="wrap-anywhere">{organization.name}</dd></div>
                <div><dt className="text-slate-400">Телефон</dt><dd className="wrap-anywhere">{contact.normalizedPhone}</dd></div>
                <div><dt className="text-slate-400">Намена</dt><dd>{contactBasisPurposeLabels[purpose]}</dd></div>
                <div><dt className="text-slate-400">Канал</dt><dd>{contactBasisChannelLabels[channel]}</dd></div>
                <div><dt className="text-slate-400">Операција</dt><dd>{review.eventType === "RECORD" ? "Евидентирање основа" : "Повлекување основа"}</dd></div>
                {review.eventType === "RECORD" && <div><dt className="text-slate-400">Вид</dt><dd>{contactBasisTypeLabels[review.basisType]}</dd></div>}
                <div className="sm:col-span-2"><dt className="text-slate-400">Референца</dt><dd className="wrap-anywhere whitespace-pre-wrap">{review.reference || "Без референца"}</dd></div>
                {review.eventType === "RECORD" && <div className="sm:col-span-2"><dt className="text-slate-400">Рок</dt><dd>{review.expiresAt ? `${review.localExpiry.replace("T", ", ")} — Europe/Skopje` : "Без наведен рок"}</dd></div>}
              </dl>
              {review.eventType === "WITHDRAW" && <p className="text-sm text-amber-100">Потврди дека ја повлекуваш основата само во прикажаната намена и канал.</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={submitting} onClick={confirmDraft} className={primaryButton}>
                  {submitting ? "Се запишува..." : review.eventType === "RECORD" ? "Потврди евидентирање" : "Потврди повлекување"}
                </button>
                <button type="button" disabled={submitting} onClick={() => setReview(null)} className={secondaryButton}>Назад</button>
                <button type="button" disabled={submitting} onClick={cancelDraft} className={secondaryButton}>Откажи</button>
              </div>
            </section>
          )}
          {writeError && <RegistryError message={writeError} />}
          {writeMessage && <p role="status" className="rounded-lg border border-slate-600 bg-slate-950/50 p-3 text-sm text-slate-200">{writeMessage}</p>}
          <p id="contact-basis-explanation" className="rounded-lg border border-amber-400/30 bg-amber-950/20 p-3 text-sm text-amber-100">
            Евидентираната основа сама по себе не одобрува испраќање.
          </p>
          {channel === "VIBER" && <p className="text-xs text-slate-400">Изборот на Viber не потврдува дека постои активна Viber интеграција.</p>}
        </div>
      </section>
    </div>
  );
}
