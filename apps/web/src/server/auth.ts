import { readServerConfig } from "@aevyra/config";
import { createAuth } from "./auth-core.ts";
import { readAuthSettings } from "./auth-settings.ts";

let runtime: (ReturnType<typeof createAuth> & { baseURL: string }) | undefined;

export function getRuntimeAuth() {
  if (!runtime) {
    const settings = readAuthSettings();
    const { databaseUrl } = readServerConfig();
    runtime = { ...createAuth(databaseUrl, settings), baseURL: settings.baseURL };
  }
  return runtime;
}

export async function getCurrentUserStrict(headers: Headers) {
  const { auth } = getRuntimeAuth();
  const session = await auth.api.getSession({ headers });
  if (session) {
    const { id, name, email } = session.user;
    return { id, name, email };
  }
  return null;
}

export async function getCurrentUser(headers: Headers) {
  try {
    return await getCurrentUserStrict(headers);
  } catch {
    // Без потврдена серверска сесија пристапот е одбиен.
    return null;
  }
}
