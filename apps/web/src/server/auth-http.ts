import { toNextJsHandler } from "better-auth/next-js";
import { getRuntimeAuth } from "./auth.ts";

export const authCacheControl = "private, no-store";

function reply(body: { ok: true } | { message: string }, status: number, sourceHeaders?: Headers) {
  const headers = new Headers(sourceHeaders);
  headers.set("Cache-Control", authCacheControl);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.delete("Content-Length");
  headers.delete("Location");
  const retryAfter = headers.get("X-Retry-After");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return Response.json(body, { status, headers });
}

export async function handleAuthPost(request: Request, operation: "sign-in" | "sign-out") {
  try {
    const { auth, baseURL } = getRuntimeAuth();
    if (request.headers.get("origin") !== baseURL || new URL(request.url).search) {
      return reply({ message: "Потеклото или адресата на барањето не е дозволена." }, 403);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      return reply({ message: "Форматот на барањето не е поддржан." }, 415);
    }
    const data: unknown = await request.clone().json().catch(() => null);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return reply({ message: "Внесените податоци не се валидни." }, 400);
    }
    const allowedFields = operation === "sign-in" ? ["email", "password"] : [];
    if (Object.keys(data).some((key) => !allowedFields.includes(key))) {
      return reply({ message: "Барањето содржи недозволени податоци." }, 403);
    }

    const response = await toNextJsHandler(auth).POST(request);
    if (response.ok) {
      // Better Auth може да ја исчисти cookie дури и кога бришењето во базата не успеало.
      if (operation === "sign-out" && await auth.api.getSession({ headers: request.headers })) {
        return reply({ message: "Одјавата не е потврдена. Обидете се повторно." }, 503);
      }
      return reply({ ok: true }, response.status, response.headers);
    }
    const error = await response.json().catch(() => null);
    let message = "Барањето за најава или одјава не успеа.";
    if (error?.code === "INVALID_EMAIL_OR_PASSWORD" || response.status === 401) {
      message = "Е-поштата или лозинката е погрешна.";
    } else if (response.status === 429) {
      message = "Премногу обиди. Обидете се повторно подоцна.";
    } else if (response.status === 403) {
      message = "Барањето не е дозволено.";
    } else if (response.status === 400 || response.status === 422) {
      message = "Внесените податоци не се валидни.";
    } else if (response.status >= 500) {
      message = "Услугата за најава моментално е недостапна.";
    }
    return reply({ message }, response.status, response.headers);
  } catch {
    return reply({ message: "Услугата за најава моментално е недостапна." }, 503);
  }
}
