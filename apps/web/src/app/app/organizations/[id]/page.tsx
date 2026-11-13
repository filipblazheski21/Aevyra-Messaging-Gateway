import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "../../../../server/auth.ts";
import { getOrganization, OrganizationError } from "../../../../server/organizations.ts";
import { SignOutForm } from "../../../auth-controls.tsx";
import { OrganizationDetails } from "../../organization-controls.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const operator = await getCurrentUser(await headers());
  if (!operator) redirect("/login");

  const { id } = await params;
  let record;
  try {
    record = await getOrganization(id);
  } catch (error) {
    if (error instanceof OrganizationError) notFound();
  }

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-10 text-slate-100 sm:px-10 sm:py-14">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <Link href="/app" className="font-semibold text-teal-300 hover:underline">Назад кон регистарот</Link>
          <SignOutForm />
        </header>
        {record ? <OrganizationDetails key={`${operator.id}:${record.id}`} initial={record} operatorId={operator.id} /> : (
          <p role="alert" className="rounded-lg border border-rose-400/40 bg-rose-950/40 p-4 text-rose-200">Деталите моментално се недостапни. Обидете се повторно.</p>
        )}
      </div>
    </main>
  );
}
