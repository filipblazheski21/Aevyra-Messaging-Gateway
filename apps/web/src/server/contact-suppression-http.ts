import { getCurrentUserStrict, getRuntimeAuth } from "./auth.ts";
import { authCacheControl } from "./auth-http.ts";
import { contactSuppressionReasons } from "../contact-suppressions.ts";
import type { ContactSuppressionReason } from "../contact-suppressions.ts";
import { ContactSuppressionError } from "./contact-suppressions.ts";
import { OrganizationError } from "./organizations.ts";

const bodyLimit = 4 * 1024;
const reasonSet = new Set<string>(contactSuppressionReasons);

export class ContactSuppressionHttpError extends Error {
  readonly status: 400 | 413 | 415;
  readonly code: string;

  constructor(status: 400 | 413 | 415, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ContactSuppressionBody = { reason: ContactSuppressionReason; reference?: string | null };

export function suppressionReply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": authCacheControl } });
}

export async function contactSuppressionResponse(
  request: Request,
  action: (operator: NonNullable<Awaited<ReturnType<typeof getCurrentUserStrict>>>) => Promise<Response>,
) {
  let operator;
  try {
    operator = await getCurrentUserStrict(request.headers);
  } catch {
    return suppressionReply({ code: "TEMPORARILY_UNAVAILABLE", message: "Евиденцијата „Не контактирај“ е привремено недостапна." }, 503);
  }
  if (!operator) return suppressionReply({ code: "AUTH_REQUIRED", message: "Потребна е најава." }, 401);
  if (request.method === "POST" && request.headers.get("origin") !== getRuntimeAuth().baseURL) {
    return suppressionReply({ code: "ORIGIN_DENIED", message: "Потеклото на барањето не е дозволено." }, 403);
  }
  try {
    return await action(operator);
  } catch (error) {
    if (error instanceof ContactSuppressionHttpError) {
      return suppressionReply({ code: error.code, message: error.message }, error.status);
    }
    if (error instanceof OrganizationError) {
      return suppressionReply({ code: error.status === 404 ? "ORGANIZATION_NOT_FOUND" : "INVALID_REQUEST", message: error.message }, error.status);
    }
    if (error instanceof ContactSuppressionError) {
      const details = {
        INVALID_INPUT: [400, "INVALID_REQUEST"],
        CONTACT_NOT_FOUND: [404, "CONTACT_NOT_FOUND"],
        OPERATOR_NOT_FOUND: [404, "OPERATOR_NOT_FOUND"],
        DATABASE_ERROR: [503, "TEMPORARILY_UNAVAILABLE"],
        OUTCOME_UNKNOWN: [503, "OUTCOME_UNKNOWN"],
      } as const;
      const [status, code] = details[error.code];
      return suppressionReply({ code, message: error.message }, status);
    }
    return suppressionReply({ code: "TEMPORARILY_UNAVAILABLE", message: "Евиденцијата „Не контактирај“ е привремено недостапна." }, 503);
  }
}

export function rejectSuppressionQuery(request: Request) {
  if (new URL(request.url).searchParams.size !== 0) {
    throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Ова барање не прифаќа параметри во адресата.");
  }
}

export async function readContactSuppressionBody(request: Request): Promise<ContactSuppressionBody> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ContactSuppressionHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Испратете го барањето во JSON формат.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (/^\d+$/.test(declaredLength) ? Number(declaredLength) : bodyLimit + 1) > bodyLimit) {
    throw new ContactSuppressionHttpError(413, "BODY_TOO_LARGE", "JSON телото не смее да надмине 4 KiB.");
  }
  if (!request.body) throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Недостасуваат податоци за ограничувањето.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > bodyLimit) {
      await reader.cancel().catch(() => undefined);
      throw new ContactSuppressionHttpError(413, "BODY_TOO_LARGE", "JSON телото не смее да надмине 4 KiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "JSON телото не е валидно.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Податоците за ограничувањето не се валидни.");
  }
  const input = parsed as Record<string, unknown>;
  if (!Object.hasOwn(input, "reason") || Object.keys(input).some((key) => !["reason", "reference"].includes(key))) {
    throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Податоците содржат недозволени или недостасувачки полиња.");
  }
  if (typeof input.reason !== "string" || !reasonSet.has(input.reason)) {
    throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Причината за ограничувањето не е поддржана.");
  }
  if (input.reference !== undefined && input.reference !== null) {
    if (typeof input.reference !== "string" || !input.reference.isWellFormed() || input.reference.includes("\0")) {
      throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Референцата не е валиден текст.");
    }
    const reference = input.reference.trim();
    if (reference === "" || Array.from(reference).length > 250) {
      throw new ContactSuppressionHttpError(400, "INVALID_REQUEST", "Референцата мора да има од 1 до 250 знаци.");
    }
    return { reason: input.reason as ContactSuppressionReason, reference };
  }
  return { reason: input.reason as ContactSuppressionReason, reference: null };
}
