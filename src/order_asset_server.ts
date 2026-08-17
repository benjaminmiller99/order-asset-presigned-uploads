import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";
import { infrai } from "./infrai_storage.js";
import { assetKindSchema, canAttachAsset, objectKey, orderStateSchema } from "./order_asset_policy.js";

const bucket = process.env.ORDER_ASSET_BUCKET ?? "commerce-order-assets";
const uploadRequestSchema = z.object({
  orderId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  state: orderStateSchema,
  kind: assetKindSchema,
  fileName: z.string().min(1).max(160),
  contentType: z.string().min(3).max(100),
  byteLength: z.number().int().positive().max(10_000_000)
}).strict();

const confirmRequestSchema = uploadRequestSchema.pick({
  orderId: true,
  kind: true,
  fileName: true
}).strict();

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "POST" && request.url === "/orders/assets/presign") {
    const parsed = uploadRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json(response, 400, { error: parsed.error.flatten() });
    const input = parsed.data;
    if (!canAttachAsset(input.state, input.kind)) {
      return json(response, 409, { error: `Cannot attach ${input.kind} while order is ${input.state}` });
    }

    const key = objectKey(input.orderId, input.kind, input.fileName);
    const requestId = createHash("sha256").update(`${input.orderId}:${key}:${input.byteLength}`).digest("hex");
    const signed = await infrai.storage.object.presign(bucket, key, {
      op: "put",
      expires_seconds: 600,
      content_type: input.contentType,
      max_bytes: input.byteLength,
      idempotency_key: requestId
    });
    return json(response, 200, { uploadUrl: signed.url, method: "PUT", key });
  }

  if (request.method === "POST" && request.url === "/orders/assets/confirm") {
    const parsed = confirmRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json(response, 400, { error: parsed.error.flatten() });
    const key = objectKey(parsed.data.orderId, parsed.data.kind, parsed.data.fileName);
    const result = await infrai.storage.object.head(bucket, key);
    return json(response, result.found ? 200 : 202, {
      orderId: parsed.data.orderId,
      kind: parsed.data.kind,
      status: result.found ? "attached" : "awaiting_upload"
    });
  }

  json(response, 404, { error: "Route not found" });
}

const port = Number(process.env.PORT ?? 3000);
createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Request failed";
    json(response, 500, { error: message });
  });
}).listen(port, () => console.log(`Order asset service listening on http://localhost:${port}`));
