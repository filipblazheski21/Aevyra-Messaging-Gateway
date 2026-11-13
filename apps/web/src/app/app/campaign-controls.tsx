"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { estimateSmsSegments } from "../../sms-segments.ts";
import { errorMessage, primaryButton, secondaryButton } from "./registry-ui.tsx";

interface TemplateItem {
  id: string;
  name: string;
  latestVersion: { id: string; versionNumber: number; body: string };
}

interface CampaignItem {
  id: string;
  name: string;
  channel: "SMS" | "VIBER";
  recipientCount: number;
  approvalStatus: "DRAFT" | "APPROVED" | "REVOKED";
}

interface ContactItem {
  id: string;
  normalizedPhone: string;
}

export function CampaignControls({ organizationId }: { organizationId: string }) {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignChannel, setCampaignChannel] = useState<"SMS" | "VIBER">("SMS");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [tRes, cRes, kRes] = await Promise.all([
        fetch(`/api/organizations/${organizationId}/templates`),
        fetch(`/api/organizations/${organizationId}/campaigns`),
        fetch(`/api/organizations/${organizationId}/contacts`),
      ]);
      if (tRes.ok) {
        const tData = (await tRes.json()) as { templates: TemplateItem[] };
        setTemplates(tData.templates);
        if (!selectedVersionId && tData.templates[0]) {
          setSelectedVersionId(tData.templates[0].latestVersion.id);
        }
      }
      if (cRes.ok) {
        const cData = (await cRes.json()) as { campaigns: CampaignItem[] };
        setCampaigns(cData.campaigns);
      }
      if (kRes.ok) {
        const kData = (await kRes.json()) as { items: ContactItem[] };
        setContacts(kData.items);
      }
    } catch {
      // ignore initial load error
    }
  }, [organizationId, selectedVersionId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const smsEstimate = estimateSmsSegments(templateBody);

  async function handleCreateTemplate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/organizations/${organizationId}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: templateName, body: templateBody, allowedVariables: [] }),
      });
      const data = (await res.json()) as { message?: string; template?: TemplateItem };
      if (!res.ok) {
        setStatusMessage(data.message ?? "Грешка при создавање шаблон.");
      } else {
        setTemplateName("");
        setTemplateBody("");
        if (data.template) setSelectedVersionId(data.template.latestVersion.id);
        setStatusMessage("Шаблонот е зачуван.");
        await loadAll();
      }
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateCampaign(event: FormEvent) {
    event.preventDefault();
    if (!selectedVersionId || contacts.length === 0) {
      setStatusMessage("Изберете шаблон и увезете барем еден контакт.");
      return;
    }
    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/organizations/${organizationId}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: campaignName,
          channel: campaignChannel,
          templateVersionId: selectedVersionId,
          recipients: contacts.map((c) => ({ contactId: c.id })),
        }),
      });
      const data = (await res.json()) as { message?: string };
      if (!res.ok) {
        setStatusMessage(data.message ?? "Грешка при создавање кампања.");
      } else {
        setCampaignName("");
        setStatusMessage("Кампањата е создадена.");
        await loadAll();
      }
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runCampaignAction(campaignId: string, path: string, body?: object, label?: string) {
    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/organizations/${organizationId}/campaigns/${campaignId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json()) as { message?: string; enqueuedCount?: number };
      if (!res.ok) {
        setStatusMessage(data.message ?? "Операцијата не успеа.");
      } else {
        setStatusMessage(
          data.enqueuedCount !== undefined
            ? `Ставени во редица: ${data.enqueuedCount} примачи.`
            : (label ?? "Операцијата е извршена."),
        );
        await loadAll();
      }
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Шаблони и кампањи</h2>
        <p className="mt-1 text-sm text-slate-400">Создадете шаблон, формирајте кампања, одобрете ја и ставете ја во редица.</p>
      </div>

      {statusMessage && (
        <p className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200">
          {statusMessage}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={handleCreateTemplate} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <h3 className="font-medium text-slate-200">Нов шаблон</h3>
          <input
            type="text"
            required
            placeholder="Име на шаблон"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          />
          <textarea
            required
            rows={3}
            placeholder="Текст на пораката..."
            value={templateBody}
            onChange={(e) => setTemplateBody(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          />
          <p className="text-xs text-slate-400">
            Кодирање: {smsEstimate.encoding} · Знаци: {smsEstimate.characterCount} · SMS сегменти: {smsEstimate.segmentCount}
          </p>
          <button type="submit" disabled={busy} className={primaryButton}>Зачувај шаблон</button>
        </form>

        <form onSubmit={handleCreateCampaign} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <h3 className="font-medium text-slate-200">Нова кампања ({contacts.length} контакти)</h3>
          <input
            type="text"
            required
            placeholder="Име на кампања"
            value={campaignName}
            onChange={(e) => setCampaignName(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          />
          <div className="flex gap-2">
            <select
              value={selectedVersionId}
              onChange={(e) => setSelectedVersionId(e.target.value)}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              {templates.map((t) => (
                <option key={t.latestVersion.id} value={t.latestVersion.id}>{t.name} (v{t.latestVersion.versionNumber})</option>
              ))}
            </select>
            <select
              value={campaignChannel}
              onChange={(e) => setCampaignChannel(e.target.value as "SMS" | "VIBER")}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              <option value="SMS">SMS</option>
              <option value="VIBER">VIBER</option>
            </select>
          </div>
          <button type="submit" disabled={busy || templates.length === 0} className={primaryButton}>Создај кампања</button>
        </form>
      </div>

      {campaigns.length > 0 && (
        <ul className="space-y-2">
          {campaigns.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div>
                <p className="font-medium text-slate-100">{c.name} ({c.channel})</p>
                <p className="text-xs text-slate-400">Примачи: {c.recipientCount} · Статус: {c.approvalStatus}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {c.approvalStatus !== "APPROVED" && (
                  <button type="button" disabled={busy} onClick={() => runCampaignAction(c.id, "approve", { decision: "APPROVED" }, "Кампањата е одобрена.")} className={secondaryButton}>Одобри</button>
                )}
                {c.approvalStatus === "APPROVED" && (
                  <>
                    <button type="button" disabled={busy} onClick={() => runCampaignAction(c.id, "enqueue")} className={secondaryButton}>Стави во редица</button>
                    <button type="button" disabled={busy} onClick={() => runCampaignAction(c.id, "control", { action: "START" }, "Кампањата е стартувана.")} className={secondaryButton}>Старт</button>
                    <button type="button" disabled={busy} onClick={() => runCampaignAction(c.id, "control", { action: "STOP" }, "Кампањата е стопирана.")} className={secondaryButton}>Стоп</button>
                    <button type="button" disabled={busy} onClick={() => runCampaignAction(c.id, "control", { action: "RESUME" }, "Кампањата е продолжена.")} className={secondaryButton}>Продолжи</button>
                    <button type="button" disabled={busy} onClick={() => runCampaignAction(c.id, "control", { action: "CANCEL" }, "Кампањата е откажана.")} className={secondaryButton}>Откажи</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
