import { betterAuth } from "better-auth";
import pg from "pg";
import type { readAuthSettings } from "./auth-settings.ts";

export const authSessionSeconds = 8 * 60 * 60;
export const minPasswordLength = 12;
export const maxPasswordLength = 128;

export function createAuth(databaseUrl: string, settings: ReturnType<typeof readAuthSettings>, onExistingUserSignUp?: () => Promise<void>) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c search_path=aevyra_auth");
  url.searchParams.delete("query_timeout");
  url.searchParams.delete("statement_timeout");
  const pool = new pg.Pool({
    connectionString: url.href,
    application_name: "aevyra-auth",
    max: 5,
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Грешките од неактивните конекции не се испраќаат до корисникот.
  pool.on("error", () => {});

  const auth = betterAuth({
    baseURL: settings.baseURL,
    basePath: "/api/auth",
    secret: settings.secret,
    trustedOrigins: [settings.baseURL],
    database: pool,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !onExistingUserSignUp,
      autoSignIn: false,
      minPasswordLength,
      maxPasswordLength,
      onExistingUserSignUp,
    },
    session: {
      expiresIn: authSessionSeconds,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rate_limit",
      window: 60,
      max: 60,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      useSecureCookies: settings.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: [] },
    },
    logger: { disabled: true },
  });
  return { auth, pool };
}
