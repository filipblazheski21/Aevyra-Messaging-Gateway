import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-14 text-slate-100">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold">Страницата не е пронајдена</h1>
        <Link className="mt-4 inline-block text-teal-300 underline" href="/">
          Вратете се на почетната страница
        </Link>
      </div>
    </main>
  );
}
