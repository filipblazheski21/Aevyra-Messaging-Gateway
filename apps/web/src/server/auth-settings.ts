import { ServerConfigError } from "@aevyra/config";

export function readAuthSettings(env: Record<string, string | undefined> = process.env) {
  const secret = env.AUTH_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{43,}$/.test(secret) || Buffer.from(secret, "base64url").length < 32) {
    throw new ServerConfigError("Потребна е валидна случајна AUTH_SECRET од најмалку 32 бајти.");
  }

  const url = URL.parse(env.AUTH_BASE_URL ?? "");
  const localHttp = env.AUTH_LOCAL_HTTP === "true";
  const loopback = url?.hostname === "127.0.0.1" || url?.hostname === "[::1]";
  if (!url || url.pathname !== "/" || url.username || url.password || url.search || url.hash
      || (env.AUTH_LOCAL_HTTP !== undefined && !["true", "false"].includes(env.AUTH_LOCAL_HTTP))
      || (localHttp ? url.protocol !== "http:" || !loopback : url.protocol !== "https:")) {
    throw new ServerConfigError("AUTH_BASE_URL мора да биде фиксна HTTPS адреса или локална HTTP адреса со AUTH_LOCAL_HTTP=true.");
  }

  return { baseURL: url.origin, secret, secureCookies: !localHttp };
}
