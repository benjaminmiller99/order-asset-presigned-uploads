const serviceUrl = process.env.ORDER_ASSET_SERVICE_URL ?? "http://localhost:3000";
const bytes = Buffer.from("receipt for order ord_1042\n", "utf8");
const request = {
  orderId: "ord_1042",
  state: "paid",
  kind: "receipt",
  fileName: "receipt.txt",
  contentType: "text/plain",
  byteLength: bytes.byteLength
};

const signedResponse = await fetch(`${serviceUrl}/orders/assets/presign`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(request)
});
if (!signedResponse.ok) throw new Error(await signedResponse.text());
const signed = await signedResponse.json() as { uploadUrl: string; method: "PUT"; key: string };

const uploadResponse = await fetch(signed.uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": request.contentType },
  body: bytes
});
if (!uploadResponse.ok) throw new Error(`Upload returned ${uploadResponse.status}`);

const confirmResponse = await fetch(`${serviceUrl}/orders/assets/confirm`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ orderId: request.orderId, kind: request.kind, fileName: request.fileName })
});
if (!confirmResponse.ok) throw new Error(await confirmResponse.text());
console.log(await confirmResponse.json());
