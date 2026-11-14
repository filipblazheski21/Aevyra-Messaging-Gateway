"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { errorMessage, primaryButton, secondaryButton } from "./registry-ui.tsx";

interface GatewayItem {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  deviceId: string | null;
  enabled: boolean;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckStatus: "OK" | "FAILED" | null;
  lastCheckDetail: string | null;
}

interface GatewayList {
  gateways: GatewayItem[];
  suggestedName: string;
  nextGateway: string | null;
}

function formatMoment(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("mk-MK", { dateStyle: "short", timeStyle: "short" });
}

const inputClass = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-teal-300";

export function SmsGatewaysSection() {
  const [data, setData] = useState<GatewayList | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("sms");
  const [password, setPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/sms-gateways", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as GatewayList;
      setData(body);
      setName((current) => (current === "" ? body.suggestedName : current));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addGateway(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/sms-gateways", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, baseUrl, username, password, deviceId }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        setMessage(body.message ?? "Телефонот не може да се зачува.");
        return;
      }
      setBaseUrl("");
      setPassword("");
      setDeviceId("");
      setName("");
      setMessage("Телефонот е додаден.");
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function patchGateway(id: string, patch: Record<string, unknown>, note: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/sms-gateways/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await response.json()) as { message?: string };
      setMessage(response.ok ? note : (body.message ?? "Промената не успеа."));
      if (response.ok) {
        setEditingId(null);
        setEditPassword("");
        await load();
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkGateway(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/sms-gateways/${id}/check`, { method: "POST" });
      const body = (await response.json()) as { message?: string; detail?: string };
      setMessage(body.detail ?? body.message ?? "Проверката заврши.");
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, gateway: GatewayItem) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await patchGateway(gateway.id, {
      name: String(form.get("name") ?? ""),
      baseUrl: String(form.get("baseUrl") ?? ""),
      username: String(form.get("username") ?? ""),
      deviceId: String(form.get("deviceId") ?? ""),
      ...(editPassword.length > 0 ? { password: editPassword } : {}),
    }, "Промените се зачувани.");
  }

  return (
    <section className="mt-5 space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-6" aria-labelledby="sms-gateways-title">
      <div>
        <h2 id="sms-gateways-title" className="text-xl font-semibold">SMS телефони</h2>
        <p className="mt-1 text-sm text-slate-300">
          Секој телефон е посебен SMSGate сервер. Пораките се распоредуваат наизменично, а по една порака се испраќа на 15–45 секунди.
        </p>
        {data?.nextGateway && (
          <p className="mt-2 text-sm text-teal-200">Следен за испраќање: <strong>{data.nextGateway}</strong></p>
        )}
      </div>

      {message && (
        <p role="status" className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200">{message}</p>
      )}

      {loading && <p role="status" className="text-sm text-slate-300">Се вчитуваат телефоните…</p>}

      {!loading && data && data.gateways.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-300">
          Сè уште нема додадено телефон. Додајте го првиот подолу.
        </p>
      )}

      {data && data.gateways.length > 0 && (
        <ul className="space-y-3">
          {data.gateways.map((gateway) => (
            <li key={gateway.id} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold text-teal-100">
                    {gateway.name}
                    {data.nextGateway === gateway.name && (
                      <span className="ml-2 rounded bg-teal-900 px-2 py-0.5 text-xs font-medium text-teal-200">следен</span>
                    )}
                    {!gateway.enabled && (
                      <span className="ml-2 rounded bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-400">исклучен</span>
                    )}
                  </p>
                  <p className="wrap-anywhere text-sm text-slate-300">{gateway.baseUrl}</p>
                  <p className="text-xs text-slate-400">
                    Корисник: {gateway.username}
                    {gateway.deviceId ? ` · Уред: ${gateway.deviceId}` : ""}
                  </p>
                  <p className="text-xs text-slate-400">
                    Последно испраќање: {formatMoment(gateway.lastUsedAt)} · Последна проверка: {formatMoment(gateway.lastCheckedAt)}
                  </p>
                  {gateway.lastCheckDetail && (
                    <p className={`text-xs ${gateway.lastCheckStatus === "OK" ? "text-teal-300" : "text-rose-300"}`}>
                      {gateway.lastCheckDetail}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={() => void checkGateway(gateway.id)} className={secondaryButton}>Провери</button>
                  <button type="button" disabled={busy}
                    onClick={() => void patchGateway(gateway.id, { enabled: !gateway.enabled }, gateway.enabled ? "Телефонот е исклучен." : "Телефонот е вклучен.")}
                    className={secondaryButton}>
                    {gateway.enabled ? "Исклучи" : "Вклучи"}
                  </button>
                  <button type="button" onClick={() => {
                    setEditingId(editingId === gateway.id ? null : gateway.id);
                    setEditPassword("");
                  }} className={secondaryButton}>
                    {editingId === gateway.id ? "Затвори" : "Измени"}
                  </button>
                </div>
              </div>

              {editingId === gateway.id && (
                <form onSubmit={(event) => void saveEdit(event, gateway)} className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Име</span>
                    <input name="name" defaultValue={gateway.name} className={inputClass} required />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Адреса</span>
                    <input name="baseUrl" defaultValue={gateway.baseUrl} className={inputClass} required />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Корисничко име</span>
                    <input name="username" defaultValue={gateway.username} className={inputClass} required />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Нова лозинка (празно = непроменета)</span>
                    <input name="password" type="password" value={editPassword} onChange={(event) => setEditPassword(event.target.value)}
                      className={inputClass} autoComplete="new-password" />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Идентификатор на уред (опционално)</span>
                    <input name="deviceId" defaultValue={gateway.deviceId ?? ""} className={inputClass} />
                  </label>
                  <div className="flex items-end">
                    <button type="submit" disabled={busy} className={primaryButton}>Зачувај</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void addGateway(event)} className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 sm:grid-cols-2">
        <h3 className="text-base font-medium text-slate-200 sm:col-span-2">Нов телефон</h3>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Име</span>
          <input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="AEV-SMS-Z" className={inputClass} required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Адреса на SMSGate</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.0.57:8080" className={inputClass} required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Корисничко име</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} className={inputClass} required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Лозинка</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} autoComplete="new-password" required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Идентификатор на уред (опционално)</span>
          <input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="79e14b" className={inputClass} />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={busy} className={primaryButton}>Додај телефон</button>
        </div>
      </form>
    </section>
  );
}
