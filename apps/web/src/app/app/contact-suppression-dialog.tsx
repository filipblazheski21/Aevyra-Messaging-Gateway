"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  contactSuppressionReasonLabels,
  contactSuppressionReasons,
} from "../../contact-suppressions.ts";
import type {
  ContactSuppression,
  ContactSuppressionReadResponse,
  ContactSuppressionReason,
  ContactSuppressionWriteResponse,
} from "../../contact-suppressions.ts";
import type { ContactListItem } from "../../contacts.ts";
import type { Organization } from "../../organizations.ts";
import { ImportTime } from "./contact-import-controls.tsx";
import {
  errorMessage,
  primaryButton,
  RegistryError,
  RegistryRequestError,
  registryRequest,
  secondaryButton,
} from "./registry-ui.tsx";

const organizationKinds = { CLINIC: "Клиника", MARKETING: "Маркетинг база" } as const;
const contactSuppressionReadTimeoutMs = 10_000;
const contactSuppressionWriteTimeoutMs = 20_000;

function timeoutMessage(action: "read" | "write") {
  return action === "read"
    ? "Читањето траеше предолго и беше прекинато. Обидете се повторно."
    : "Чекањето на одговорот истече. Исходот не е потврден. Проверете ја реалната состојба пред повторување.";
}

function SuppressionDetails({ suppression }: { suppression: ContactSuppression }) {
  return (
    <div className="space-y-3 rounded-lg border border-rose-400/40 bg-rose-950/30 p-4">
      <p className="font-semibold text-rose-200">Не контактирај</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-slate-400">Причина</dt><dd>{contactSuppressionReasonLabels[suppression.reason]}</dd></div>
        <div><dt className="text-slate-400">Евидентирано</dt><dd><ImportTime value={suppression.recordedAt} /></dd></div>
        {suppression.reference && <div className="sm:col-span-2"><dt className="text-slate-400">Референца</dt><dd className="wrap-anywhere whitespace-pre-wrap">{suppression.reference}</dd></div>}
      </dl>
      <p className="text-xs text-slate-300">Ограничувањето важи за оваа организација и за сите идни канали.</p>
    </div>
  );
}

export function ContactSuppressionDialog({ organization, contact, onClose, onConfirmed }: {
  organization: Organization;
  contact: ContactListItem;
  onClose: () => void;
  onConfirmed: (suppression: ContactSuppression) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [suppression, setSuppression] = useState<ContactSuppression | null>(null);
  const [reason, setReason] = useState<ContactSuppressionReason>("CONTACT_REQUEST");
  const [reference, setReference] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const submitSequence = useRef(0);
  const submission = useRef(false);
  const mounted = useRef(true);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const path = `/${organization.id}/contacts/${contact.id}/suppression`;

  async function readCurrent(checking = false) {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = ++sequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, contactSuppressionReadTimeoutMs);
    setLoading(true);
    setError("");
    try {
      const result = await registryRequest<ContactSuppressionReadResponse>(path, { signal: controller.signal });
      if (!mounted.current || sequence.current !== current) return;
      setSuppression(result.suppression);
      if (result.suppression) {
        setUncertain(false);
        setMessage(checking ? "Исходот е потврден од серверот." : "");
        onConfirmed(result.suppression);
      } else if (checking) {
        setUncertain(false);
        setConfirming(true);
        setMessage("Нема потврден запис. Може безбедно да повторите за истиот контакт.");
      }
    } catch (failure) {
      if (mounted.current && sequence.current === current) {
        setError(timedOut ? timeoutMessage("read") : errorMessage(failure));
      }
    } finally {
      window.clearTimeout(timeout);
      if (readController.current === controller) readController.current = null;
      if (mounted.current && sequence.current === current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void readCurrent();
    return () => {
      mounted.current = false;
      sequence.current++;
      submitSequence.current++;
      readController.current?.abort();
      readController.current = null;
      writeController.current?.abort();
      writeController.current = null;
      submission.current = false;
    };
  }, [contact.id, organization.id]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setMessage("");
    setError("");
    setConfirming(true);
  }

  async function submit() {
    if (submission.current) return;
    submission.current = true;
    const controller = new AbortController();
    writeController.current = controller;
    const current = ++submitSequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, contactSuppressionWriteTimeoutMs);
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const body: { reason: ContactSuppressionReason; reference?: string } = { reason };
      if (reference.trim() !== "") body.reference = reference.trim();
      const result = await registryRequest<ContactSuppressionWriteResponse>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!mounted.current || submitSequence.current !== current) return;
      setSuppression(result.suppression);
      setUncertain(false);
      setConfirming(false);
      setMessage(result.message);
      onConfirmed(result.suppression);
    } catch (failure) {
      if (!mounted.current || submitSequence.current !== current) return;
      if (!(failure instanceof RegistryRequestError) || failure.code === "OUTCOME_UNKNOWN") {
        setUncertain(true);
        setMessage(timedOut
          ? timeoutMessage("write")
          : "Исходот не е потврден. Проверете ја реалната состојба пред повторување.");
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      window.clearTimeout(timeout);
      if (writeController.current === controller) writeController.current = null;
      if (submitSequence.current === current) {
        submission.current = false;
        if (mounted.current) setSubmitting(false);
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-3 sm:items-center sm:p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="contact-details-title"
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-teal-300">{organizationKinds[organization.kind]} · {organization.name}</p>
            <h2 id="contact-details-title" className="mt-1 wrap-anywhere text-xl font-semibold">{contact.normalizedPhone}</h2>
          </div>
          <button type="button" disabled={submitting} onClick={onClose} className={secondaryButton} aria-label="Затвори детали">Затвори</button>
        </div>

        <div className="mt-5 space-y-4">
          {loading && <p role="status" className="text-sm text-slate-300">Се чита евиденцијата…</p>}
          {error && <div className="space-y-3"><RegistryError message={error} /><button type="button" disabled={loading} onClick={() => void readCurrent(uncertain)} className={secondaryButton}>Обиди се повторно</button></div>}
          {!loading && !error && suppression && <SuppressionDetails suppression={suppression} />}
          {!loading && !error && !suppression && !confirming && !uncertain && (
            <form onSubmit={review} className="space-y-4">
              <p className="rounded-lg border border-slate-600 bg-slate-950/50 p-3 text-sm text-slate-200">Нема евидентирано ограничување. Ова не претставува согласност или дозвола за испраќање.</p>
              <label className="block space-y-2 text-sm">
                <span className="font-medium">Причина</span>
                <select value={reason} onChange={(event) => setReason(event.target.value as ContactSuppressionReason)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300">
                  {contactSuppressionReasons.map((value) => <option key={value} value={value}>{contactSuppressionReasonLabels[value]}</option>)}
                </select>
              </label>
              <label className="block space-y-2 text-sm">
                <span className="font-medium">Референца (опционално)</span>
                <input value={reference} maxLength={250} onChange={(event) => setReference(event.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 focus:border-teal-300" />
              </label>
              <button type="submit" className={primaryButton}>Евидентирај „Не контактирај“</button>
            </form>
          )}

          {!loading && !error && !suppression && confirming && (
            <div className="space-y-4 rounded-lg border border-amber-400/40 bg-amber-950/20 p-4">
              <h3 className="font-semibold">Потврда за ограничување</h3>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-400">Организација</dt><dd className="wrap-anywhere">{organization.name} · {organizationKinds[organization.kind]}</dd></div>
                <div><dt className="text-slate-400">Телефон</dt><dd className="wrap-anywhere">{contact.normalizedPhone}</dd></div>
                <div><dt className="text-slate-400">Причина</dt><dd>{contactSuppressionReasonLabels[reason]}</dd></div>
                <div><dt className="text-slate-400">Референца</dt><dd className="wrap-anywhere whitespace-pre-wrap">{reference.trim() || "Нема референца"}</dd></div>
              </dl>
              <p className="text-sm text-amber-100">Ограничувањето важи само за овој контакт во оваа организација, за сите идни канали. Во тековниот интерфејс нема опција за отстранување.</p>
              {!uncertain && <div className="flex flex-wrap gap-2">
                <button type="button" disabled={submitting} onClick={() => void submit()} className={primaryButton}>{submitting ? "Се евидентира…" : "Потврди ограничување"}</button>
                <button type="button" disabled={submitting} onClick={() => { setConfirming(false); setMessage(""); }} className={secondaryButton}>Откажи</button>
              </div>}
            </div>
          )}

          {message && <p role="status" className="rounded-lg border border-slate-600 bg-slate-950/50 p-3 text-sm text-slate-200">{message}</p>}
          {uncertain && <button type="button" disabled={loading} onClick={() => void readCurrent(true)} className={primaryButton}>Провери исход</button>}
        </div>
      </section>
    </div>
  );
}
