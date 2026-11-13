import parsePhoneNumber from "libphonenumber-js/max";
import type { PhoneNormalization, PhoneSourceKind } from "../import-preview.ts";

const invalidNumber = {
  status: "INVALID", reasonCode: "INVALID_NUMBER", reason: "Бројот не одговара на нумерациските правила.",
} as const;

export function normalizePhone(value: string, sourceKind: PhoneSourceKind): PhoneNormalization {
  if (sourceKind === "number") {
    return {
      status: "REVIEW", reasonCode: "NUMERIC_SOURCE",
      reason: "Excel ја зачувал вредноста како број. Изгубени водечки нули или + не можат сигурно да се вратат.",
    };
  }

  // Unicode space separators are horizontal spaces. Tabs and line breaks are control characters.
  const compact = value.replace(/\p{Zs}/gu, "");
  if (compact === "") {
    return { status: "EMPTY", reasonCode: "EMPTY_VALUE", reason: "Телефонското поле е празно." };
  }
  const hasPlus = compact.startsWith("+");
  const body = (hasPlus ? compact.slice(1) : compact).replace(/\(([0-9]+(?:-[0-9]+)*)\)/g, "$1");
  if (!/^[0-9]+(?:-[0-9]+)*$/.test(body)) {
    return { status: "INVALID", reasonCode: "UNSUPPORTED_CONTENT", reason: "Вредноста мора да содржи еден број со дозволено форматирање." };
  }
  const digits = body.replaceAll("-", "");
  const hasDoubleZero = !hasPlus && digits.startsWith("00");
  const national = !hasPlus && !hasDoubleZero && digits.startsWith("0");
  if (!hasPlus && !hasDoubleZero && !national) {
    return {
      status: "REVIEW", reasonCode: "AMBIGUOUS_PREFIX",
      reason: "Недостасува експлицитен меѓународен префикс или почетна 0 за македонски број.",
    };
  }

  const expected = national ? "+389" + digits.slice(1) : "+" + digits.slice(hasDoubleZero ? 2 : 0);
  if (!/^\+[1-9][0-9]{0,14}$/.test(expected)) return invalidNumber;
  const phone = national
    ? parsePhoneNumber(digits, { defaultCountry: "MK", extract: false })
    : parsePhoneNumber(expected, { extract: false });
  if (!phone?.isValid()) return invalidNumber;
  if (phone.number !== expected || (national && phone.country !== "MK")) {
    return {
      status: "REVIEW", reasonCode: "DIGITS_CHANGED",
      reason: "Толкувањето на бројот бара промена на цифрите надвор од дозволените правила.",
    };
  }
  return {
    status: "VALID", reasonCode: "VALID_FORMAT", reason: "Форматот одговара на нумерациските правила.",
    normalizedPhone: phone.number, country: phone.country, phoneType: phone.getType(),
  };
}
