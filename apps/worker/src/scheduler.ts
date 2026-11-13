export const DEFAULT_TIME_ZONE = "Europe/Skopje";
export const MIN_INTERVAL_SECONDS = 15;
export const MAX_INTERVAL_SECONDS = 45;

export function getSkopjeHour(date: Date, timeZone = DEFAULT_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number.parseInt(hourPart, 10);
}

export function isWithinWorkingHours(
  date: Date,
  startHour = 8,
  endHour = 20,
  timeZone = DEFAULT_TIME_ZONE,
): boolean {
  const hour = getSkopjeHour(date, timeZone);
  return hour >= startHour && hour < endHour;
}

export function clampSendIntervalSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_INTERVAL_SECONDS;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)));
}

export function randomSendIntervalMs(
  minSeconds = MIN_INTERVAL_SECONDS,
  maxSeconds = MAX_INTERVAL_SECONDS,
  rng: () => number = Math.random,
): number {
  const min = clampSendIntervalSeconds(minSeconds);
  const max = Math.max(min, clampSendIntervalSeconds(maxSeconds));
  const seconds = min + Math.floor(rng() * (max - min + 1));
  return seconds * 1000;
}

export function canSendUnderChannelLimit(sentInWindow: number, maxPerWindow: number): boolean {
  return sentInWindow < maxPerWindow;
}
