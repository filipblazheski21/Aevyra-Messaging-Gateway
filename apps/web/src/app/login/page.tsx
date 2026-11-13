import Link from "next/link";
import { SignInForm } from "../auth-controls.tsx";

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-16 text-slate-100 sm:py-24">
      <section className="mx-auto max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 sm:p-8" aria-labelledby="login-title">
        <Link href="/" className="text-sm font-semibold text-teal-300 hover:underline">Aevyra Messaging Gateway</Link>
        <h1 id="login-title" className="mt-3 mb-7 text-3xl font-semibold tracking-tight">Најава</h1>
        <SignInForm />
      </section>
    </main>
  );
}
