"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ContactListItem, ContactListPage } from "../../contacts.ts";
import type { ContactSuppression } from "../../contact-suppressions.ts";
import type { Organization } from "../../organizations.ts";
import { formatPreviewCount } from "../../import-preview.ts";
import { buildViberChatUrl } from "../../viber-link.ts";
import { ImportTime } from "./contact-import-controls.tsx";
import { errorMessage, primaryButton, RegistryError, registryRequest, secondaryButton } from "./registry-ui.tsx";
import { ContactSuppressionDialog } from "./contact-suppression-dialog.tsx";
import { ContactBasisDialog } from "./contact-basis-dialog.tsx";

export function ContactList({ organization, operatorId, confirmedImportId }: {
  organization: Organization;
  operatorId: string;
  confirmedImportId?: string;
}) {
  const organizationId = organization.id;
  const [draftSearch, setDraftSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<ContactListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selectedSuppression, setSelectedSuppression] = useState<ContactListItem | null>(null);
  const [selectedBasis, setSelectedBasis] = useState<ContactListItem | null>(null);
  const [viberMessage, setViberMessage] = useState("Почитувани, ве потсетуваме за вашиот термин.");
  const basisReturnFocus = useRef<HTMLElement | null>(null);
  const requestSequence = useRef(0);
  const refreshedImport = useRef<string | null>(null);
  const confirmedSuppressions = useRef(new Set<string>());
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    confirmedSuppressions.current.clear();
    setSelectedSuppression(null);
    setSelectedBasis(null);
  }, [organizationId]);

  useEffect(() => {
    if (!confirmedImportId) return;
    const token = `${organizationId}:${confirmedImportId}`;
    if (refreshedImport.current === token) return;
    refreshedImport.current = token;
    requestSequence.current++;
    setPage(null);
    setLoading(true);
    setError("");
    setCursors([null]);
    setRefresh((current) => current + 1);
  }, [confirmedImportId, organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    const params = new URLSearchParams();
    if (activeSearch !== "") params.set("search", activeSearch);
    if (cursor) params.set("cursor", cursor);
    setLoading(true);
    setError("");
    registryRequest<ContactListPage>(`/${organizationId}/contacts${params.size ? `?${params}` : ""}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && requestSequence.current === sequence) {
          setPage({
            ...result,
            items: result.items.map((item) => confirmedSuppressions.current.has(item.id) ? { ...item, hasSuppression: true } : item),
          });
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && requestSequence.current === sequence) {
          setPage(null);
          setError(errorMessage(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSequence.current === sequence) setLoading(false);
      });
    return () => controller.abort();
  }, [activeSearch, cursor, organizationId, refresh]);

  function applySearch(value: string) {
    const trimmed = value.trim();
    setPage(null);
    setCursors([null]);
    if (trimmed === activeSearch) setRefresh((current) => current + 1);
    else setActiveSearch(trimmed);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    applySearch(draftSearch);
  }

  function clearSearch() {
    setDraftSearch("");
    applySearch("");
  }

  function changePage(next: (string | null)[]) {
    setPage(null);
    setCursors(next);
  }

  function confirmSuppression(value: ContactSuppression) {
    if (value.organizationId !== organizationId) return;
    confirmedSuppressions.current.add(value.contactId);
    setPage((current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === value.contactId ? { ...item, hasSuppression: true } : item),
    } : current);
    setSelectedSuppression((current) => current?.id === value.contactId ? { ...current, hasSuppression: true } : current);
    setSelectedBasis((current) => current?.id === value.contactId ? { ...current, hasSuppression: true } : current);
  }

  function closeBasis() {
    setSelectedBasis(null);
    window.requestAnimationFrame(() => basisReturnFocus.current?.focus());
  }

  return (
    <section className="min-w-0 space-y-4 border-t border-slate-700 pt-5" aria-labelledby="saved-contacts-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="saved-contacts-title" className="text-xl font-semibold">Зачувани контакти</h2>
          <p className="mt-1 text-sm text-slate-300">
            Вкупно во организацијата: <strong className="text-slate-100 tabular-nums">{page ? formatPreviewCount(page.totalContacts) : "—"}</strong>
          </p>
        </div>
      </div>

      <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <label className="block min-w-0 space-y-2">
          <span className="block text-sm font-medium">Пребарај по почеток на меѓународен број</span>
          <input type="search" inputMode="tel" value={draftSearch} placeholder="+38970" autoComplete="off"
            aria-describedby="contact-search-help" onChange={(event) => setDraftSearch(event.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-300" />
          <span id="contact-search-help" className="block text-xs text-slate-400">
            На пример +38970. Дозволени се опционално + и од 3 до 15 цифри.
          </span>
        </label>
        <button type="submit" disabled={loading} className={primaryButton}>Пребарај</button>
        <button type="button" disabled={loading || (draftSearch === "" && activeSearch === "")} onClick={clearSearch} className={secondaryButton}>
          Исчисти
        </button>
      </form>

      {error && <div className="space-y-3">
        <RegistryError message={error} />
        <button type="button" onClick={() => setRefresh((current) => current + 1)} className={secondaryButton}>Обиди се повторно</button>
      </div>}
      {loading && !error && <p role="status" className="text-sm text-slate-300">Се вчитуваат контактите…</p>}

      {page && !loading && !error && <>
        {page.totalContacts === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-300">Во оваа организација сè уште нема зачувани контакти.</p>
        ) : page.matchedContacts === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-300">Нема контакти што одговараат на пребарувањето.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="viber-prefill-message" className="text-xs font-medium text-slate-300">Viber порака за копирање:</label>
              <input
                id="viber-prefill-message"
                type="text"
                value={viberMessage}
                onChange={(e) => setViberMessage(e.target.value)}
                placeholder="Внесете порака за Viber..."
                className="min-w-64 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100"
              />
            </div>
            <p className="text-sm text-slate-300">
              Совпаднати резултати: <strong className="text-slate-100 tabular-nums">{formatPreviewCount(page.matchedContacts)}</strong>
            </p>
            <ul className="divide-y divide-slate-700 rounded-lg border border-slate-700" aria-label="Зачувани контакти">
              {page.items.map((contact) => (
                <li key={contact.id} className="flex min-w-0 flex-col gap-3 px-4 py-3">
                  <div className="min-w-0 space-y-1.5">
                    <span className="block wrap-anywhere font-medium text-teal-100">{contact.normalizedPhone}</span>
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${contact.hasSuppression ? "bg-rose-950 text-rose-200" : "bg-slate-800 text-slate-300"}`}>
                      {contact.hasSuppression ? "Не контактирај" : "Нема евидентирано ограничување"}
                    </span>
                    <span className="block text-sm text-slate-300">Додаден на <ImportTime value={contact.createdAt} /></span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setSelectedSuppression(contact)} className={secondaryButton}>Отвори контакт</button>
                    <button type="button" onClick={(event) => {
                      basisReturnFocus.current = event.currentTarget;
                      setSelectedBasis(contact);
                    }} className={secondaryButton}>Основа за контакт</button>
                    {buildViberChatUrl(contact.normalizedPhone) && (
                      <>
                        <a href={buildViberChatUrl(contact.normalizedPhone)!} className={secondaryButton}>Отвори во Viber</a>
                        <button
                          type="button"
                          onClick={async () => {
                            if (viberMessage.trim().length > 0) {
                              await navigator.clipboard?.writeText(viberMessage.trim()).catch(() => {});
                            }
                            window.location.href = buildViberChatUrl(contact.normalizedPhone)!;
                          }}
                          className={secondaryButton}
                        >
                          Копирај и отвори во Viber
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={contact.hasSuppression}
                      onClick={async () => {
                        const text = window.prompt(`SMS порака до ${contact.normalizedPhone}:`, "Почитувани, ве потсетуваме за вашиот термин.");
                        if (!text || text.trim().length === 0) return;
                        try {
                          const res = await fetch(`/api/organizations/${organization.id}/contacts/${contact.id}/send-sms`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ message: text }),
                          });
                          const data = (await res.json()) as { message?: string; externalId?: string };
                          window.alert(res.ok ? `SMS прифатена за испраќање (${data.externalId ?? ""}).` : (data.message ?? "Грешка при испраќање."));
                        } catch {
                          window.alert("Мрежна грешка при испраќање SMS.");
                        }
                      }}
                      className={secondaryButton}
                    >
                      Испрати SMS
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(cursors.length > 1 || page.nextCursor) && (
          <nav aria-label="Страници со контакти" className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={cursors.length === 1} onClick={() => changePage(cursors.slice(0, -1))} className={secondaryButton}>Претходна</button>
            <span className="px-1 text-sm text-slate-300 tabular-nums">Страница {formatPreviewCount(cursors.length)}</span>
            <button type="button" disabled={!page.nextCursor} onClick={() => changePage([...cursors, page.nextCursor])} className={secondaryButton}>Следна</button>
          </nav>
        )}
      </>}
      {selectedSuppression && <ContactSuppressionDialog key={`${organizationId}:${selectedSuppression.id}`} organization={organization} contact={selectedSuppression}
        onClose={() => setSelectedSuppression(null)} onConfirmed={confirmSuppression} />}
      {selectedBasis && <ContactBasisDialog key={`${organizationId}:${selectedBasis.id}`} organization={organization} contact={selectedBasis}
        operatorId={operatorId}
        onClose={closeBasis} />}
    </section>
  );
}
