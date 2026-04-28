export type FeishuWebhookResult = {
  ok: boolean;
  status: number;
  code?: number;
  msg?: string;
};

export async function sendFeishuInteractiveWebhook(
  webhookUrl: string,
  card: unknown,
  options: { timeoutMs?: number } = {},
): Promise<FeishuWebhookResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "interactive", card }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: { code?: number; msg?: string } = {};
    try { parsed = JSON.parse(text) as { code?: number; msg?: string }; } catch {}
    return {
      ok: response.ok && (parsed.code === undefined || parsed.code === 0),
      status: response.status,
      code: parsed.code,
      msg: parsed.msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const token = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const redacted = token.length > 8 ? `${token.slice(0, 4)}...${token.slice(-4)}` : "***";
    parsed.pathname = parsed.pathname.replace(token, redacted);
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}
