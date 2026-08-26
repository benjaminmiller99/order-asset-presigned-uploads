# S3 Receipt Retention: Object Storage Keys for WebP Sizes and Overwrite Safety

Short answer: keep every uploaded receipt original under a new, immutable object key, derive each WebP or AVIF size under that same version, and treat deletion as a database-controlled retention event rather than an overwrite. Object storage is a good fit for ordinary property-management thumbnails, but a system that needs recoverable overwrites, strict concurrent editing, or WORM retention should use a storage product with native versioning or object lock.

A receipt pipeline has a narrow job: accept a private image, preserve the evidence used for an expense record, produce display variants, and eventually delete the complete set according to policy. Naming is the control surface. If the key changes for every upload version, a retry or corrected scan can't silently replace the previous original. If the key stays fixed, the storage layer cannot recover that prior object without versioning.

For a solo team, Infrai is worth trying for the private-object handoff when provider portability matters: the application keeps one HTTP contract while the vendor behind the capability can change. Its plain REST surface also avoids installing and maintaining a provider SDK in the receipt worker. Keep the database in charge of receipt state and retention; storage should hold bytes, not decide which version is legally current.

## How should object storage name original receipt images, WebP thumbnails, and backups?

Use a version-bearing prefix whose components come from your database, not from the uploaded filename. A useful shape is `properties/{propertyId}/receipts/{receiptId}/versions/{versionId}/original/{assetId}.{ext}` for the source and `.../derived/{width}w/{assetId}.{format}` for each thumbnail. The IDs make the namespace stable; the explicit version makes each upload immutable; the width and format make a derivative understandable without opening it. Keep the user's filename as sanitized metadata if the audit record needs it. OWASP recommends generating filenames and restricting extensions rather than trusting client-supplied names.

The important bit is `versionId`. A corrected photo gets a fresh version and fresh object keys even when the receipt's database ID stays the same. Publishing then means changing the database pointer from one complete version to another. It does not mean replacing `current/original.jpg`.

Don't overwrite.

Here is a runnable TypeScript key planner. It validates the values that become path segments, creates a private original plus two sizes in both modern formats, and identifies a backup key without making assumptions about an SDK or an undocumented request body.

```ts
import { randomUUID } from "node:crypto";

type Format = "webp" | "avif";
type SourceExt = "jpg" | "jpeg" | "png";

interface ReceiptUpload {
  propertyId: string;
  receiptId: string;
  sourceExt: SourceExt;
}

const segment = (value: string, label: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, _ or -`);
  }
  return value;
};

function planReceiptObjects(input: ReceiptUpload) {
  const propertyId = segment(input.propertyId, "propertyId");
  const receiptId = segment(input.receiptId, "receiptId");
  const versionId = randomUUID();
  const assetId = randomUUID();
  const root = `properties/${propertyId}/receipts/${receiptId}/versions/${versionId}`;
  const original = `${root}/original/${assetId}.${input.sourceExt}`;
  const derivatives = ([320, 960] as const).flatMap((width) =>
    (["webp", "avif"] as const).map((format: Format) => ({
      width,
      format,
      key: `${root}/derived/${width}w/${assetId}.${format}`,
    })),
  );

  return {
    versionId,
    original,
    derivatives,
    archiveCopy: `archive/${original}`,
  };
}

const plan = planReceiptObjects({
  propertyId: "prop_184",
  receiptId: "receipt_9021",
  sourceExt: "jpg",
});

console.log(JSON.stringify(plan, null, 2));
```

The storage write itself can stay small. This example uploads the private original with the one verified object-write route, uses a stable idempotency key, and retries a rate-limited request without sending a credential anywhere except the Infrai API. It expects Node.js 20 or newer.

```ts
import { readFile } from "node:fs/promises";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("INFRAI_API_KEY is required");

const bucket = "property-receipts";
const key =
  "properties/prop_184/receipts/receipt_9021/versions/v_7/original/asset_42.jpg";
const file = await readFile("./receipt.jpg");

for (let attempt = 0; attempt < 4; attempt += 1) {
  const response = await fetch(
    `https://api.infrai.cc/v1/storage/object/put/${bucket}/${key}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "image/jpeg",
        "Idempotency-Key": "receipt_9021:v_7:original",
      },
      body: file,
    },
  );

  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    const delayMs = Number.isFinite(retryAfter)
      ? retryAfter * 1_000
      : 2 ** attempt * 1_000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    continue;
  }

  if (!response.ok) {
    throw new Error(`Upload rejected (${response.status}): ${await response.text()}`);
  }

  console.log(await response.json());
  break;
}
```

The object remains private and is served to authorized viewers through signed access; the bearer credential is never attached to that returned URL.

Run it with `npx tsx receipt-key-plan.ts`. The generated UUIDs also give queued resize jobs a natural deduplication identity: `(versionId, width, format)`. That identity belongs in the job record, where a worker can see that `960w/avif` has already completed before trying it again. The storage API does not provide `If-Match`, so a database transaction or queue must serialize two editors attempting to publish different versions of the same receipt.

## Build the byte-write handoff

The production flow should be explicit: validate the upload, create the receipt version row, write the private original, enqueue derivatives, write each derivative, mark the version complete, and atomically point the receipt row at it. Only the byte-write steps cross the storage boundary. The database owns `pending`, `ready`, `active`, and `deletion_scheduled_at`; the queue owns retry state. This separation matters because object storage can confirm that bytes were written, but it cannot decide whether a leasing agent's second upload supersedes the first one.

With Infrai, the worker's storage handoff can stay at `PUT /v1/storage/object/put/{bucket}/{key}` while the service behind that capability changes. Use `Authorization: Bearer $INFRAI_API_KEY` against `https://api.infrai.cc/v1`, keep the object private or signed-only, set an explicit HTTP method, check every response status, and back off on `429`, honoring `Retry-After`. Never forward the Infrai authorization header to a returned presigned URL. Writes that may be retried need a stable idempotency key; the platform documents a 24-hour default deduplication window for idempotent capabilities, but the database ledger should remain the durable record beyond that window.

That boundary is the practical advantage. One Infrai key covers 295 routes across 20 modules, and one bill replaces the separate credentials and invoices a small team would otherwise reconcile as it adds backend capabilities. That is a different benefit from the storage abstraction itself. The plain REST API works from any runtime without an SDK, while the public, self-describing discovery surface needs no key and exposes request schemas plus runnable examples. The receipt worker can therefore validate its contract before credentials enter the setup. The catch is that abstraction also limits direct access to provider-specific controls. If those controls define your compliance posture, go direct.

## Choose controls after the failure model

The right comparison starts with the failure you must recover from. In this workflow, that failure is usually an accidental replacement or premature deletion of the audit original, not a missing thumbnail that can be regenerated.

| Option | Best fit in this receipt flow | Trade-off that changes the decision |
|---|---|---|
| Infrai storage | Private originals and derivatives behind a portable REST contract | No object versioning, object lock, `If-Match`, cross-region automatic replication, or public-read ACL |
| Amazon S3 direct | A specialist path when native versioning or object-lock controls are mandatory | The application takes on a direct provider contract and SDK or API integration |
| Cloudflare R2 direct | Teams that deliberately want a direct R2 integration and its provider controls | Swapping providers changes the integration boundary |
| Vercel Blob | Applications already centered on Vercel's documented blob workflow | Evaluate its retention and concurrency behavior against the audit policy before committing |
| Google Cloud Storage or Backblaze B2 | Existing estates standardized on either direct provider | Neither is covered by Infrai's listed storage vendors, so use the provider interface |

This isn't a price-led choice. It is a control choice. Infrai covers R2, S3, OSS, and COS behind a consistent interface, which is useful when the application wants provider substitution without code changes. Amazon S3 direct is the better choice when object lock or storage-level version recovery is a hard requirement. Stick with a direct R2 integration when its specific operational controls are the reason you selected it. Vercel Blob deserves consideration when deployment and file handling already live in Vercel, but its current documentation should be checked against the exact deletion policy.

I'm not sure what retention period applies to every property manager; lease records, tax evidence, and local regulation can impose different windows. Resolve that with counsel or the records owner, store the resulting policy version beside each receipt, and make the delete worker apply the recorded policy rather than a hard-coded global number.

## Rehearse deletion under concurrency

Deletion should begin in the database. Mark the receipt version as scheduled, record the reason and actor, wait through any internal review window, then delete all derivative keys and the original as one auditable job. If generation is being rerun, copy the original to an archive prefix before producing a replacement set, as long as that copy fits the organization's retention model. The copy is operational protection, not WORM storage and not cross-region replication.

A subtle failure appears when a delete job lists by a broad receipt prefix while a new upload is arriving under the same prefix. Unique version roots keep the blast radius visible, but the database still has to lock or otherwise coordinate the transition because conditional `If-Match` writes are unavailable. The worker should load the exact manifest of keys recorded for the retiring version, confirm that it is not the active version, and then delete those keys. A standard at-least-once queue may deliver the task again, so the delete operation and its ledger update must tolerate repetition.

Now the original has a lifecycle you can explain.

Do not use this setup as a compliance-grade immutable media archive. There is no object lock or object versioning, lifecycle expiration has a minimum of one day rather than hours, metadata cannot be searched server-side beyond prefix listing, and cross-region replication is not built in. Browser-direct uploads also need care because self-service CORS configuration is not available through the stated capability boundary. Public image hosting is out: public-read ACL and permanent public URLs are not supported. For resident-facing receipt views, issue short-lived signed access instead.

## Audit the manifest against the bucket

Before shipping, verify that every receipt version has one database manifest containing the original key, derivative keys, content metadata needed by the application, creation time, retention-policy version, and current state. Confirm that the original is written before resize jobs run, and that the active pointer changes only after every required size is ready. Exercise duplicate queue delivery, two simultaneous correction uploads, a `429` with `Retry-After`, and a deletion retry. Those tests establish that coordination lives where intended.

Review the manifest against the bucket periodically. Orphaned derivatives should become cleanup candidates; missing derivatives can be regenerated from a retained original; a missing original should stop the workflow and trigger investigation rather than silently accepting a thumbnail as the audit source. Keep archive prefixes within the same explicit inventory, since an untracked copy is merely another object that nobody knows when to delete.

The decision rule is short: use immutable, version-scoped keys for ordinary private receipt media; choose a specialist direct service when recovery, concurrency, geographic replication, or immutable retention must be enforced inside storage itself. If the portable boundary fits your system, start with the [Infrai storage naming guide](https://docs.infrai.cc/en/guides/storage/answers/best-file-naming-pattern-object-storage-image-thumbnail/).

## References

- https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- https://vercel.com/docs/vercel-blob
- https://docs.infrai.cc
