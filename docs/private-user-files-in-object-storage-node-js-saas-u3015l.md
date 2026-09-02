# Private User Files in Object Storage: Node.js SaaS Presigned Download Links

For private SaaS documents, make the application authorize each request before it creates a short-lived signed download link, then prove the same flow in the US and EU locations where the product stores data. A bucket feature checklist is weaker evidence than a denial test, an expiry test, and a restore test run against the intended region.

Short answer: private object storage with application-controlled authorization and narrowly scoped signed links is a sound default for document delivery; use an authenticated download service instead when access must be re-evaluated while bytes are flowing.

The data flow is deliberately plain. A user asks the application for a document. The application authenticates the request, looks up the document under that user's tenant, evaluates policy, and only then asks a storage adapter for a time-limited URL. The browser fetches the file from storage directly. The application remains the policy decision point without carrying every PDF or spreadsheet through its API fleet.

Keep the signing path boring.

That separation matters for a small team. It prevents download traffic from deciding how many API replicas are needed, and it keeps document ownership, retention, and deletion state in the database where product code can inspect it. It also makes a later storage migration less invasive because the business handler depends on a small interface rather than a provider-specific client throughout the codebase.

## How should a Node.js SaaS issue presigned download links for private user document storage?

Start private, and treat the object key as an internal locator rather than proof that a caller owns a file. A route parameter such as `documentId` may identify an application record; it should not be copied into an object key and passed straight to a signer. The lookup must constrain the row by tenant or organization before the code obtains a capability URL. Returning the same not-found response for a missing record and a record from another tenant can also reduce what an attacker learns from enumeration.

The focused TypeScript example makes the order visible in review. It has no vendor SDK because authorization should not depend on one. The adapter implementation can use the object-storage protocol selected by the platform, while the route continues to own tenant policy and the short lifetime.

```ts
interface DocumentRecord {
  id: string;
  tenantId: string;
  objectKey: string;
  downloadName: string;
}

interface DocumentRepository {
  findForTenant(documentId: string, tenantId: string): Promise<DocumentRecord | null>;
}

interface PrivateObjectStore {
  createDownloadUrl(input: {
    objectKey: string;
    expiresInSeconds: number;
    downloadName: string;
  }): Promise<URL>;
}

export async function createDocumentDownload(input: {
  documentId: string;
  tenantId: string;
  documents: DocumentRepository;
  objects: PrivateObjectStore;
}): Promise<URL> {
  const document = await input.documents.findForTenant(
    input.documentId,
    input.tenantId,
  );

  if (!document) {
    throw new Error("Document not found");
  }

  return input.objects.createDownloadUrl({
    objectKey: document.objectKey,
    expiresInSeconds: 300,
    downloadName: document.downloadName,
  });
}
```

Five minutes is an application policy, not a universal value. A 300-second link may be too long for a highly sensitive document and too short for a large file on a slow connection. Measure the interval from link issuance to the storage request, then choose a lifetime that covers a normal tail without turning a copied URL into a durable credential. Do not log the entire signed query string. Until it expires, that string is bearer material.

There is an important semantic limit. A signed URL delegates access at the moment it is issued; it does not ask the SaaS to re-check authorization on every subsequent byte. The catch is that this pattern is not a good fit for material requiring immediate revocation, inline malware inspection, transformation, or a fresh entitlement check throughout the transfer. Keep those downloads behind an authenticated proxy or gateway, accepting the compute, bandwidth, and latency budget that continuous enforcement costs.

## What failure modes should private SaaS file storage test before release?

The useful acceptance suite is small enough to run in continuous integration and specific enough to reject unsafe integrations. Attempt an anonymous download, a cross-tenant download, an expired link, a deleted document, and a replay after the user's entitlement has changed. The cross-tenant case must fail before signing. The expiry case should require a new application authorization decision before another URL is created. A filename containing spaces or non-ASCII characters belongs in the fixtures too, because content-disposition behavior is part of a document product, not a cosmetic detail.

For uploads, test interruption and cleanup as a single workflow. Multipart upload splits one object into independently uploaded parts that can be retried before completion; the AWS overview describes that model and its completion step. This does not establish every service's lifecycle behavior, so an evaluation should explicitly verify what happens to abandoned parts, how completed objects are named, and how a client resumes or restarts after a network change. A useful fixture starts a multipart upload, sends several parts, drops the client before completion, and then checks three things: the application record is not marked available, a retry cannot accidentally attach parts to a different tenant's key, and the cleanup policy eventually accounts for abandoned work. Repeat the fixture with a file whose original name has spaces and non-ASCII characters, then verify that the signed download presents the expected safe filename. The point is to make recovery behavior observable before users encounter it, because a happy-path upload demonstrates very little about what the document system will do when a mobile connection changes, a worker retries, or a browser follows an old link. Large uploads expose assumptions quickly.

Test the exit.

Record each outcome, its region, and the configuration revision that produced it. A passing request in a developer's default location is not evidence that the production US or EU path is configured correctly. The more revealing test is an upload in the intended location followed by a download, deletion, and restore exercise performed with the production-like identity and policy. Keep signed URLs out of test snapshots and CI logs for the same reason they stay out of application logs.

| Check | Evidence to keep | Failure that changes the design |
| --- | --- | --- |
| Tenant isolation | Anonymous and cross-tenant requests never receive a URL | A caller can sign an object key without an application lookup |
| Signed access | Expiry and replay tests have expected results | A link is treated as a revocable session |
| Regional placement | Object, backup, and restore locations are recorded | US/EU residency cannot be demonstrated |
| Recovery | Interrupted upload and deletion fixtures complete predictably | Abandoned data has no accountable cleanup path |

## Place US and EU data with an auditable boundary

US/EU placement is broader than a dropdown labeled region. The evaluation needs written answers for primary objects, replicas, backups, object metadata, access logs, and the support or administrative path that can reach them. A system can keep file bytes in one location while leaving a backup or audit trail under a different control, so the deployment review should describe the complete data path rather than relying on a marketing label.

For health information, NIST SP 800-66 Rev. 2 maps the HIPAA Security Rule to security safeguards and is a useful engineering reference for documenting controls. It does not replace legal advice, a risk analysis, or the contractual work that determines where a particular SaaS may process data. Requirements can differ by customer and data class, so retain a per-tenant placement decision in configuration and make the request path reject an unsupported placement instead of silently selecting a convenient default.

There is a practical portability test here as well: export a bounded fixture, verify its checksums where the selected service supports that verification, and restore it in the permitted region. An object key alone is not a recovery plan. The database record, encryption-key access, retention policy, and application authorization state must still line up after the exercise.

## Operate the document path as one system

Storage cost should be modeled with the request pattern, not inferred from stored gigabytes. Include uploads, reads, retrieval, data transfer, replicas, incomplete multipart work, preview generation, and deletion jobs. A normal month is useful, but a burst after an import, a customer export, or a retry loop is often the scenario that shows whether the design is affordable and whether rate limits or queues have an owner. Don't treat a headline unit price as an architecture decision.

Observability should connect an application request to its document record and storage operation without recording the signed capability. Track authorization denials, signing latency, upload completion, missing-object outcomes, cleanup lag, bytes transferred, and restoration results. An alert needs an operator action attached to it; a raw count of storage errors is rarely enough to locate a tenant-policy error, a bad lifecycle rule, or an expired credential.

Deletion deserves the same discipline as download. Mark the document unavailable in application state, prevent future authorization, submit deletion work, and verify the result with a retryable worker. Retention holds, backups, and replicas may change the meaning and timing of deletion, so the product promise should use language that the operations design can meet. This is slower than adding a public link. It is also much easier to defend when a customer asks how private documents are handled.

The decision is not a ranking exercise. Select the implementation that can demonstrate tenant isolation, permitted US/EU placement, predictable large-file recovery, and a tested deletion-and-restore path for the actual SaaS workload. If those tests are absent, more storage features will not make the document system ready.

## References

- AWS S3 documentation, "Multipart upload overview": https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
- NIST SP 800-66 Rev. 2, "Implementing the HIPAA Security Rule": https://csrc.nist.gov/pubs/sp/800/66/r2/final
