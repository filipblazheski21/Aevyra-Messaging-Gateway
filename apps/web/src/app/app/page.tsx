import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignOutForm } from "../auth-controls.tsx";
import { getCurrentUser } from "../../server/auth.ts";
import { OrganizationSection } from "./organization-controls.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ProtectedPage() {
  const user = await getCurrentUser(await headers());
  if (!user) redirect("/login");

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-10 text-slate-100 sm:px-10 sm:py-14">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-5 border-b border-slate-800 pb-6">
          <div>
            <p className="text-sm font-semibold text-teal-300">Aevyra Messaging Gateway</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">Добредојдовте, {user.name}</h1>
            <p className="mt-2 text-slate-300">Внатрешен регистар</p>
          </div>
          <SignOutForm />
        </header>
        <div className="grid items-start gap-5 md:grid-cols-2">
          <OrganizationSection kind="CLINIC" />
          <OrganizationSection kind="MARKETING" />
        </div>
      </div>
    </main>
  );
}
