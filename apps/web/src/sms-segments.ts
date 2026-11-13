export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SmsSegmentEstimate {
  encoding: SmsEncoding;
  characterCount: number;
  segmentCount: number;
  perSegmentLimit: number;
}

const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM7_EXTENDED = new Set("^{}\\[~]|€");

export function estimateSmsSegments(text: string): SmsSegmentEstimate {
  let gsmUnits = 0;
  let isGsm7 = true;

  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) {
      gsmUnits += 1;
    } else if (GSM7_EXTENDED.has(ch)) {
      gsmUnits += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    if (gsmUnits === 0) {
      return { encoding: "GSM-7", characterCount: 0, segmentCount: 0, perSegmentLimit: 160 };
    }
    const perSegmentLimit = gsmUnits <= 160 ? 160 : 153;
    const segmentCount = gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
    return { encoding: "GSM-7", characterCount: gsmUnits, segmentCount, perSegmentLimit };
  }

  const ucs2Units = text.length; // UTF-16 code units
  if (ucs2Units === 0) {
    return { encoding: "UCS-2", characterCount: 0, segmentCount: 0, perSegmentLimit: 70 };
  }
  const perSegmentLimit = ucs2Units <= 70 ? 70 : 67;
  const segmentCount = ucs2Units <= 70 ? 1 : Math.ceil(ucs2Units / 67);
  return { encoding: "UCS-2", characterCount: ucs2Units, segmentCount, perSegmentLimit };
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractTemplateVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return [...found];
}

export function renderTemplateBody(
  body: string,
  allowedVariables: readonly string[],
  values: Record<string, string | null | undefined>,
): { ok: true; rendered: string; estimate: SmsSegmentEstimate } | { ok: false; error: string } {
  const allowed = new Set(allowedVariables);
  const used = extractTemplateVariables(body);

  for (const variable of used) {
    if (!allowed.has(variable)) {
      return { ok: false, error: `Непозната променлива во шаблонот: {{${variable}}}.` };
    }
    const val = values[variable];
    if (typeof val !== "string" || val.trim().length === 0) {
      return { ok: false, error: `Недостасува вредност за променливата: {{${variable}}}.` };
    }
  }

  const rendered = body.replace(VARIABLE_PATTERN, (_, name: string) => values[name]!.trim());
  if (rendered.trim().length === 0) {
    return { ok: false, error: "Содржината на пораката не може да биде празна." };
  }

  return { ok: true, rendered, estimate: estimateSmsSegments(rendered) };
}
