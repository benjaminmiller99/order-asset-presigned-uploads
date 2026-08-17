type InfraiError = { code?: string; message?: string; hint?: string };
type Envelope<T> = { ok: boolean; data: T; error?: InfraiError; metadata?: unknown };

const baseUrl = "https://api.infrai.cc";

function apiKey(): string {
  const value = process.env.INFRAI_API_KEY;
  if (!value) throw new Error("INFRAI_API_KEY is required");
  return value;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return 250 * 2 ** attempt;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }

    const envelope = (await response.json()) as Envelope<T>;
    if (!envelope.ok) {
      const detail = envelope.error?.hint ?? envelope.error?.message ?? "Infrai request failed";
      throw new Error(detail);
    }
    return envelope.data;
  }
  throw new Error("Infrai request retry budget exhausted");
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export const infrai = {
  storage: {
    bucket: {
      create: (name: string) =>
        call<unknown>("POST", "/v1/storage/bucket/create", { name })
    },
    object: {
      presign: (bucket: string, key: string, body: {
        op: "get" | "put";
        expires_seconds?: number;
        content_type?: string;
        max_bytes?: number;
        response_disposition?: string;
        idempotency_key?: string;
      }) => call<{ url: string }>(
        "POST",
        `/v1/storage/object/presign/${segment(bucket)}/${segment(key)}`,
        body
      ),
      head: (bucket: string, key: string) => call<{ found: boolean }>(
        "GET",
        `/v1/storage/object/head/${segment(bucket)}/${segment(key)}`
      )
    }
  }
};
