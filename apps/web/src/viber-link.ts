export function buildViberChatUrl(phoneE164: string): string | null {
  const trimmed = phoneE164.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
    return null;
  }
  return `viber://chat?number=${encodeURIComponent(trimmed)}`;
}
