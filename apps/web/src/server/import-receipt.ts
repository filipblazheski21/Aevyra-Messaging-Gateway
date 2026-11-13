import { createHmac, timingSafeEqual } from "node:crypto";
import type { ImportConfirmation } from "../import-preview.ts";
import { readAuthSettings } from "./auth-settings.ts";
import { readImportSource, uuidPattern } from "./contact-imports.ts";
import type { PreparedContactImport } from "./contact-imports.ts";

const purpose = "aevyra.contact-import.preview";
const lifetimeMs = 30 * 60 * 1000;
const hashPattern = /^[0-9a-f]{64}$/;
const receiptKeys = [
  "purpose", "version", "organizationId", "operatorId", "idempotencyKey", "sourceSha256",
  "source", "policyVersion", "libraryVersion", "fingerprint", "issuedAt", "expiresAt",
] as const;

function signature(body: string) {
  const key = createHmac("sha256", readAuthSettings().secret).update(`${purpose}.signing-key.v1`).digest();
  return createHmac("sha256", key).update(body, "ascii").digest();
}

export function issueImportReceipt(prepared: PreparedContactImport, fingerprint: string): ImportConfirmation {
  const { organizationId, operatorId, idempotencyKey, sourceSha256, source, policyVersion, libraryVersion } = prepared;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetimeMs;
  const body = Buffer.from(JSON.stringify({
    purpose, version: 1, organizationId, operatorId, idempotencyKey, sourceSha256,
    source, policyVersion, libraryVersion, fingerprint, issuedAt, expiresAt,
  })).toString("base64url");
  return { receipt: `${body}.${signature(body).toString("base64url")}`, idempotencyKey, expiresAt, source };
}

export function readImportReceipt(token: unknown, organizationId: string, operatorId: string) {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [body, encodedSignature] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  const provided = Buffer.from(encodedSignature, "base64url");
  if (bytes.toString("base64url") !== body || provided.toString("base64url") !== encodedSignature
      || provided.length !== 32 || !timingSafeEqual(provided, signature(body))) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Object.keys(value).length !== receiptKeys.length
        || receiptKeys.some((key) => !Object.hasOwn(value, key))) return null;
    const data = value as Record<(typeof receiptKeys)[number], unknown>;
    const { idempotencyKey, sourceSha256, policyVersion, libraryVersion, fingerprint, issuedAt, expiresAt } = data;
    if (data.purpose !== purpose || data.version !== 1 || data.organizationId !== organizationId || data.operatorId !== operatorId
        || !uuidPattern.test(organizationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(operatorId)
        || typeof idempotencyKey !== "string" || !uuidPattern.test(idempotencyKey) || idempotencyKey !== idempotencyKey.toLowerCase()
        || typeof sourceSha256 !== "string" || !hashPattern.test(sourceSha256)
        || typeof fingerprint !== "string" || !hashPattern.test(fingerprint)
        || typeof policyVersion !== "string" || !/^phone-normalization-v[1-9][0-9]{0,5}$/.test(policyVersion)
        || typeof libraryVersion !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(libraryVersion)
        || typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > Date.now()
        || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt - issuedAt !== lifetimeMs) return null;
    return { idempotencyKey, sourceSha256, source: readImportSource(data.source), policyVersion, libraryVersion, fingerprint, expiresAt };
  } catch {
    return null;
  }
}

export type VerifiedImportReceipt = NonNullable<ReturnType<typeof readImportReceipt>>;
