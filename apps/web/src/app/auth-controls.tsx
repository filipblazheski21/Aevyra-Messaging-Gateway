"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

const inputStyle = "w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none focus:border-teal-300 focus:ring-1 focus:ring-teal-300";

function AuthForm({ signingIn, children }: { signingIn: boolean; children?: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const fields = new FormData(event.currentTarget);
      const response = await fetch(signingIn ? "/api/auth/sign-in/email" : "/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signingIn ? { email: fields.get("email"), password: fields.get("password") } : {}),
      });
      if (response.ok) {
        window.location.replace(signingIn ? "/app" : "/login");
        return;
      }
      const result = await response.json();
      if (typeof result.message === "string") {
        setMessage(result.message);
        return;
      }
      throw new Error();
    } catch {
      setMessage("Барањето не успеа. Обидете се повторно.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5" method="post"
      action={signingIn ? "/api/auth/sign-in/email" : "/api/auth/sign-out"}>
      {children}
      {message && <p role="alert" className="rounded-lg border border-rose-400/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">{message}</p>}
      <button type="submit" disabled={pending} className="rounded-lg bg-teal-300 px-5 py-2.5 font-semibold text-slate-950 hover:bg-teal-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 disabled:opacity-60">
        {signingIn ? "Најави се" : "Одјави се"}
      </button>
    </form>
  );
}

export function SignInForm() {
  return (
    <AuthForm signingIn>
      <label className="block space-y-2">
        <span className="block text-sm font-medium">Е-пошта</span>
        <input type="email" name="email" autoComplete="username" required maxLength={254} className={inputStyle} />
      </label>
      <label className="block space-y-2">
        <span className="block text-sm font-medium">Лозинка</span>
        <input type="password" name="password" autoComplete="current-password" required maxLength={128} className={inputStyle} />
      </label>
    </AuthForm>
  );
}

export function SignOutForm() {
  return <AuthForm signingIn={false} />;
}
