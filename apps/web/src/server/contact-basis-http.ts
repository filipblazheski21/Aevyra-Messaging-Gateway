import { authCacheControl } from "./auth-http.ts";
import { getCurrentUserStrict, getRuntimeAuth } from "./auth.ts";
import {
  contactBasisChannels,
  ContactBasisError,
  contactBasisPurposes,
} from "./contact-bases.ts";
import type {
  ContactBasisChannel,
  ContactBasisPurpose,
} from "./contact-bases.ts";

const bodyLimit = 4 * 1024;
const purposeSet = new Set<string>(contactBasisPurposes);
const channelSet = new Set<string>(contactBasisChannels);

export class ContactBasisHttpError extends Error {
  readonly status: 400 | 413 | 415;
  readonly code: string;

  constructor(status: 400 | 413 | 415, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ContactBasisQuery = {
  purpose: ContactBasisPurpose;
  channel: ContactBasisChannel;
};

export type ContactBasisHttpBody = {
  eventType: "RECORD" | "WITHDRAW";
  fields: Record<string, unknown>;
};

export function basisReply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": authCacheControl } });
}

export function contactBasisErrorReply(error: unknown) {
  if (error instanceof ContactBasisHttpError) {
    return basisReply({ code: error.code, message: error.message }, error.status);
  }
  if (error instanceof ContactBasisError) {
    const details = {
      INVALID_INPUT: [400, "INVALID_REQUEST", error.message],
      PURPOSE_NOT_ALLOWED: [400, "PURPOSE_NOT_ALLOWED", error.message],
      ORGANIZATION_NOT_FOUND: [404, "ORGANIZATION_NOT_FOUND", error.message],
      CONTACT_NOT_FOUND: [404, "CONTACT_NOT_FOUND", error.message],
      OPERATOR_NOT_FOUND: [503, "TEMPORARILY_UNAVAILABLE", "Услугата за основи за контакт е привремено недостапна."],
      REVISION_CONFLICT: [409, "REVISION_CONFLICT", error.message],
      IDEMPOTENCY_CONFLICT: [409, "IDEMPOTENCY_CONFLICT", error.message],
      DATABASE_ERROR: [503, "TEMPORARILY_UNAVAILABLE", "Услугата за основи за контакт е привремено недостапна."],
      OUTCOME_UNKNOWN: [503, "OUTCOME_UNKNOWN", error.message],
    } as const;
    const [status, code, message] = details[error.code];
    return basisReply({ code, message }, status);
  }
  return basisReply({
    code: "TEMPORARILY_UNAVAILABLE",
    message: "Услугата за основи за контакт е привремено недостапна.",
  }, 503);
}

export async function contactBasisResponse(
  request: Request,
  action: (operator: NonNullable<Awaited<ReturnType<typeof getCurrentUserStrict>>>) => Promise<Response>,
) {
  let operator;
  try {
    operator = await getCurrentUserStrict(request.headers);
  } catch {
    return basisReply({
      code: "TEMPORARILY_UNAVAILABLE",
      message: "Услугата за основи за контакт е привремено недостапна.",
    }, 503);
  }
  if (!operator) return basisReply({ code: "AUTH_REQUIRED", message: "Потребна е најава." }, 401);
  if (request.method === "POST" && request.headers.get("origin") !== getRuntimeAuth().baseURL) {
    return basisReply({ code: "ORIGIN_DENIED", message: "Потеклото на барањето не е дозволено." }, 403);
  }
  try {
    return await action(operator);
  } catch (error) {
    return contactBasisErrorReply(error);
  }
}

export function readContactBasisQuery(request: Request): ContactBasisQuery {
  const params = new URL(request.url).searchParams;
  if (params.size !== 2
      || params.getAll("purpose").length !== 1
      || params.getAll("channel").length !== 1
      || [...params.keys()].some((key) => !["purpose", "channel"].includes(key))) {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "Потребни се точно една намена и еден канал.");
  }
  const purpose = params.get("purpose");
  const channel = params.get("channel");
  if (!purpose || !purposeSet.has(purpose) || !channel || !channelSet.has(channel)) {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "Намената или каналот не се дозволени.");
  }
  return { purpose: purpose as ContactBasisPurpose, channel: channel as ContactBasisChannel };
}

export function rejectContactBasisPostQuery(request: Request) {
  if (new URL(request.url).searchParams.size !== 0) {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "POST барањето не дозволува query параметри.");
  }
}

function hasJsonContentType(value: string | null) {
  if (!value) return false;
  const [mediaType, ...parameters] = value.split(";");
  if (mediaType.trim().toLowerCase() !== "application/json") return false;
  let charsetSeen = false;
  for (const parameter of parameters) {
    if (charsetSeen || !/^\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(parameter)) return false;
    charsetSeen = true;
  }
  return true;
}

async function readLimitedJson(request: Request) {
  if (!hasJsonContentType(request.headers.get("content-type"))) {
    throw new ContactBasisHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Барањето мора да користи application/json со UTF-8 charset.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (/^\d+$/.test(declaredLength) ? Number(declaredLength) : bodyLimit + 1) > bodyLimit) {
    throw new ContactBasisHttpError(413, "BODY_TOO_LARGE", "JSON телото не смее да надмине 4 KiB.");
  }
  if (!request.body) throw new ContactBasisHttpError(400, "INVALID_REQUEST", "Недостасува JSON тело.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > bodyLimit) {
      await reader.cancel().catch(() => undefined);
      throw new ContactBasisHttpError(413, "BODY_TOO_LARGE", "JSON телото не смее да надмине 4 KiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "JSON телото не е валидно.");
  }
}

export async function readContactBasisBody(request: Request): Promise<ContactBasisHttpBody> {
  const parsed = await readLimitedJson(request);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "Барањето мора да биде JSON објект.");
  }
  const input = parsed as Record<string, unknown>;
  if (input.eventType !== "RECORD" && input.eventType !== "WITHDRAW") {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "eventType мора да биде RECORD или WITHDRAW.");
  }
  const common = ["eventType", "purpose", "channel", "expectedRevision", "idempotencyKey"];
  const allowed = input.eventType === "RECORD"
    ? [...common, "basisType", "reference", "expiresAt"]
    : [...common, "reference"];
  const required = input.eventType === "RECORD"
    ? [...common, "basisType", "reference"]
    : common;
  if (Object.keys(input).some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(input, key))) {
    throw new ContactBasisHttpError(400, "INVALID_REQUEST", "Барањето содржи непознати, недозволени или недостасувачки полиња.");
  }
  const { eventType, ...fields } = input;
  return { eventType, fields };
}
