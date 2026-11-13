export const primaryButton = "rounded-lg bg-teal-300 px-4 py-2 font-semibold text-slate-950 hover:bg-teal-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 disabled:opacity-60";
export const secondaryButton = "rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-teal-300 disabled:opacity-60";

export class RegistryRequestError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function errorMessage(error: unknown) {
  return error instanceof RegistryRequestError ? error.message : "Барањето не успеа. Обидете се повторно.";
}

export async function registryRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/organizations${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (typeof body?.message === "string") throw new RegistryRequestError(body.message, body.code);
    throw new Error();
  }
  return response.json();
}

export function RegistryError({ message }: { message: string }) {
  return <p role="alert" className="rounded-lg border border-rose-400/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">{message}</p>;
}

