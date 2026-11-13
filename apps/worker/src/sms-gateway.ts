export type SmsGatewayOutcome =
  | { status: "ACCEPTED"; externalId: string }
  | { status: "FAILED"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export interface SmsGatewayConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export async function sendViaSmsGate(
  config: SmsGatewayConfig,
  input: { idempotencyKey: string; phoneNumber: string; message: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsGatewayOutcome> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/message`;
  const auth = Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        id: input.idempotencyKey,
        message: input.message,
        phoneNumbers: [input.phoneNumber],
      }),
      signal: controller.signal,
    });

    if (response.status >= 400 && response.status < 500) {
      return { status: "FAILED", reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { status: "UNKNOWN", reason: `HTTP ${response.status}` };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { status: "UNKNOWN", reason: "Нечитлив одговор од SMSGate." };
    }

    if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).id === "string") {
      return { status: "ACCEPTED", externalId: (data as Record<string, unknown>).id as string };
    }
    return { status: "UNKNOWN", reason: "Непотполн одговор од SMSGate." };
  } catch (error) {
    return {
      status: "UNKNOWN",
      reason: error instanceof Error ? error.message : "Мрежна грешка при поврзување со SMSGate.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
