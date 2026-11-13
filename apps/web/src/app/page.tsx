import Link from "next/link";
import { getDatabaseStatus } from "../server/database-status.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  const database = await getDatabaseStatus();
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-14 text-slate-100 sm:px-10 sm:py-24">
      <div className="mx-auto max-w-3xl">
        <header className="border-b border-slate-800 pb-9">
          <p className="mb-4 text-sm font-semibold tracking-wide text-teal-300">Развојна околина</p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">Aevyra Messaging Gateway</h1>
        </header>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <section className="rounded-xl border border-slate-700 bg-slate-900 p-5" aria-labelledby="sending-title">
            <h2 id="sending-title" className="text-sm font-medium text-slate-300">Испраќање пораки</h2>
            <p className="mt-2 text-lg font-semibold text-amber-200">Вистинското испраќање е оневозможено</p>
          </section>
          <section className="rounded-xl border border-slate-700 bg-slate-900 p-5" aria-labelledby="database-title">
            <h2 id="database-title" className="text-sm font-medium text-slate-300">База на податоци</h2>
            <p className={`mt-2 text-lg font-semibold ${database.ready ? "text-teal-300" : "text-amber-200"}`}>
              {database.ready ? "Достапна" : "Недостапна"}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{database.message}</p>
          </section>
        </div>
        <Link href="/login" className="mt-8 inline-block font-semibold text-teal-300 hover:underline">Најава</Link>
      </div>
    </main>
  );
}
