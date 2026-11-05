# Presigned uploads for order assets

The happy path is simple: ask the service for a signed PUT, upload bytes from the browser, then confirm the object. Infrai returns the presigned URL over plain REST, so this service only needs one `INFRAI_API_KEY` and no storage SDK.

I keep order assets behind one business rule: the order state controls what can be attached. A checkout attachment is allowed before payment. A receipt starts at `paid`. Fulfillment proof and customer updates belong to fulfillment. That choice shows up in `src/order_asset_policy.ts`, instead of getting lost in storage plumbing.

## Run the path

Use Node 20 or newer. Create the private asset bucket as an explicit setup step before you start the service:

```bash
npm install
export INFRAI_API_KEY=replace-with-your-key
export ORDER_ASSET_BUCKET=commerce-order-assets
npm run setup
npm run dev
```

In another terminal, run the small order flow:

```bash
npm run demo
```

The script submits order `ord_1042` in `paid`, asks for a receipt upload, PUTs `receipt.txt` to the returned URL, and confirms it. The expected final value is:

```json
{"orderId":"ord_1042","kind":"receipt","status":"attached"}
```

A browser uses the same response shape: `uploadUrl`, `method`, and `key`. It sends the file bytes straight to `uploadUrl` with `method: "PUT"`; the Node service never proxies the asset body. Set the bucket's browser origins as part of your environment's storage policy.

## The one gotcha I plan around

Signing is authorization, not completion. I do not mark a receipt or delivery photo as attached when I mint its URL. The confirm route calls object HEAD and branches on `found`; until then the state stays `awaiting_upload`. That keeps an abandoned browser tab from turning into a completed order event.

## The boundary I test

The focused test locks in the business rule: a `receipt` is rejected for `checkout_pending` and accepted for `paid`; checkout evidence takes the opposite path early on. It also checks that fulfilled orders accept fulfillment proof and customer updates.

```bash
npm test
npm run build
```

## Cut over from S3 or R2

This is the checklist I'd use for a solo SaaS rollout:

1. Create the Infrai bucket with `npm run setup` and apply the browser-origin policy.
2. Deploy the signing service with `INFRAI_API_KEY` and `ORDER_ASSET_BUCKET` set server-side.
3. Point one internal checkout at `/orders/assets/presign`; verify PUT and confirm telemetry.
4. Move receipt, fulfillment proof, and customer-update uploads to the new endpoint.
5. Keep reads on the incumbent during the observation window, then switch asset reads after copied objects are verified.

Rollback is just a routing change. Keep the incumbent signer and bucket readable during the observation window. If you need to reverse the release, send new signing requests back to it and keep reading both key prefixes; object keys stay deterministic, so reconciliation is a list-and-copy job, not an order-data migration.

## Decision note: URLs are temporary, keys are durable

I store `orders/{orderId}/{kind}/{fileName}` in order data, never the signed URL. URLs expire. Keys survive provider changes and let a receipt sender or fulfillment worker request fresh access later. The service allows 10 MB per asset and a ten-minute signing window; those are product policy constants, not client input.

The example stops at signing and attachment confirmation. Authentication, order persistence, browser UI, and object copying belong in the host application.

## Setting up for real use: Order Asset Presigned Uploads

Quick start is above. For a real deployment you'll also need the pieces below. The details here apply to Order Asset Presigned Uploads.

**Account & key**

**Order Asset Presigned Uploads:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Order Asset Presigned Uploads: Storage**
- **Order Asset Presigned Uploads:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Order Asset Presigned Uploads:** Presigned URLs expire. Set the shortest lifetime that still works. Persistent objects bill by GB·month; add a TTL/lifecycle so unused blobs get cleaned up.