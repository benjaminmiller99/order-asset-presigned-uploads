# Marketplace Image Uploads in Node.js: Sharp Crops, Fixed Sizes, One Private Original

Use a presigned upload that puts the browser's bytes directly into a private object store, keep that original untouched, and let a background worker derive the two or three Sharp sizes your storefront actually renders. For a marketplace where sellers upload 8–24 MB phone photos and shop avatars all day, the expensive decision isn't which resize library to call — it's whether the raw file ever passes through your API process at all. It shouldn't. Everything after that (crop geometry, thumbnail sizes, how you save and serve each variant) is cheap to change; the upload path is not.

It's easy to spend a week tuning WebP quality settings while a single Node process quietly buffers a 20 MB multipart body per seller. That's the wrong order of worries.

## The byte pump is the part that costs you

An image endpoint that accepts multipart bodies is doing three jobs at once: authentication, transport, and transformation. Transport is the one that scales badly. Every in-flight upload holds a socket, a chunk of heap, and a request slot on a box you're paying for by the hour, and a seller on hotel Wi-Fi can hold all three for two minutes. Ten of them and your checkout endpoints are queuing behind product photos.

Storage is elastic. Your API process is not.

Direct-to-store uploads split those jobs apart. Your API only issues a short-lived signed PUT for one exact key, with a content type and a size ceiling baked into the signature; the bytes travel from the seller's laptop to the bucket without touching your runtime. What you give up is the ability to inspect the file before it lands — you can't reject a 40 MB TIFF at the door if you never see it. You get that back with a size-limited signature plus a worker that validates the object after the fact and deletes what doesn't pass.

Presigned uploads are an S3-compatible primitive, and most object stores expose some version of it; Firebase Cloud Storage takes a different route, handing clients download tokens and enforcing access with security rules rather than per-object signatures. Different mechanism, same architectural point: the storage layer, not your app, should be the thing moving bytes.

## Should Sharp crop the original at upload time, or should private object storage stay dumb?

Precompute. A marketplace renders a small, knowable set of shapes — a 96 px seller avatar in the review list, a 320 px square card in search results, a 1024 px zoom on the product page — and precomputing those means the read path is a signed GET of an object that already exists, with no image processing anywhere near a page render.

On-the-fly resizing sounds cheaper because you skip storing variants. In practice you trade a bounded, one-time cost at upload for an unbounded, repeated cost at read time, plus a new cache to reason about and a new way to get slow under load. Storage is the cheapest resource in this whole system. CPU during a traffic spike is the most expensive.

The crop semantics matter more than the pixel counts. A square avatar needs `fit: "cover"`, which fills the box and trims the overflow; `contain` would letterbox a portrait shot into an ugly bordered square. Call `.rotate()` with no argument first so Sharp applies the EXIF orientation that phone cameras write, otherwise a third of your seller avatars arrive sideways. And save the original exactly as uploaded — no re-encode, no strip. It's the only copy that can regenerate the set when design asks for a 512 px variant next quarter, and re-encoding a JPEG to "normalize" it throws away quality you can never get back.

Multiple fixed sizes, one immutable original, zero surprises at read time.

## A worker that derives the set, then flips one pointer

The pattern that keeps this honest is versioned keys plus a single database write at the end. The worker writes every derivative under a fresh version prefix, verifies each one, and only then updates the row that says which version is live. Readers see the previous version until the whole set exists, and a retried job targets the same keys without corrupting anything.

```ts
import sharp from "sharp";

interface ObjectStore {
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  head(key: string): Promise<{ bytes: number; contentType: string }>;
}

const SIZES = [96, 320, 1024] as const;

export async function deriveVariants(store: ObjectStore, prefix: string, originalKey: string) {
  const input = await store.get(originalKey);
  const meta = await sharp(input).metadata();
  if (!meta.format || !["jpeg", "png", "webp", "avif"].includes(meta.format)) {
    throw new Error(`rejected upload: unsupported format ${meta.format ?? "unknown"}`);
  }

  const written: { key: string; bytes: number }[] = [];
  for (const size of SIZES) {
    // cover crops to a square; attention keeps the subject rather than the geometric centre
    const body = await sharp(input)
      .rotate()
      .resize(size, size, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();

    const key = `${prefix}/square-${size}.webp`;
    await store.put(key, body, "image/webp");
    const stat = await store.head(key);
    if (stat.bytes !== body.length) throw new Error(`size mismatch for ${key}`);
    written.push({ key, bytes: stat.bytes });
  }

  return { prefix, variants: written };
}
```

Two details in there earn their keep. The metadata check runs before any pixel work, so a renamed PDF costs you one parse instead of three encodes, and the error it throws is a validation result you can show the seller rather than a stack trace from deep inside a decoder. The `head` call after each put is what lets the caller treat "the set exists" as a fact rather than a hope — if the stored length doesn't line up, the job throws, the pointer never moves, and the storefront keeps rendering last week's photo while the queue retries. That retry is safe precisely because the keys are derived from the version prefix instead of a timestamp or a random id: attempt three overwrites attempt two byte-for-byte, and a genuinely newer upload gets its own prefix and competes only at the single row update. I'd rather re-encode three images than reason about a half-published set on a Saturday.

Then one update: `UPDATE listing_media SET live_prefix = $1 WHERE listing_id = $2`. Object storage answers "what bytes are at this key"; your database answers "which key should this listing render". Don't let a `LIST` call by prefix become your product logic — listings are eventually consistent in some stores and always slower than an indexed row.

## Access control versus delivery simplicity

This is the axis worth arguing about, and there's no answer that's right for every object in a marketplace. Private storage plus signed reads gives you revocation, per-viewer authorization and an audit trail. Public objects with a long cache give you a URL you can put in an email, a sitemap, or a customer's browser cache for a year.

| Delivery model | Where it fits | The catch |
| --- | --- | --- |
| Private object + short-lived signed GET | Seller identity documents, draft listings, anything a moderator can revoke | Every URL expires, so nothing caches well downstream and each page render mints new links |
| Public object + immutable versioned key | Live catalog images served worldwide at high volume | Access control ends at publish time; the only revocation is deleting the object and waiting out caches |
| App-proxied read | Fine-grained rules that must live in your code | Your servers are back to pumping bytes, which is the problem you just solved |

Most marketplaces need both, split by object rather than by policy. The original and any moderation-relevant asset stays private forever; the derived card and zoom images for a published listing become public, cache-forever objects keyed by content version. Serving a private original as a download rather than an inline render is a `Content-Disposition: attachment` header, per RFC 6266 — a rendering hint, not an access control, and treating it as one is a common way to ship an authorization hole.

The catch with going private-only is worth stating plainly: signed URLs and CDN caching pull in opposite directions. If your product page is 30 images and every one of them needs a fresh signature per viewer, you've built a system that can't be cached by anyone, and your storage egress bill will tell you so. Stick with public immutable objects for the public catalog. Reach for signed reads where the access decision is real.

Split by object, not by policy.

And if your entire product is arbitrary user-specified transforms — a design tool, a print shop — fixed variants stop being a simplification and a dedicated image transformation service earns its cost. Fixed sets are a bet that you know your shapes. Most storefronts do.

## What to measure before copying any of this

Four numbers tell you whether this design fits your traffic. Total stored bytes per listing across the original and its variants, because that's what the fixed-set bet costs you. CPU seconds per upload, which caps how many derivations one worker can absorb during a seasonal spike. The ratio of variant requests actually served from cache, which is how you find out you're precomputing a size nobody renders. And the age distribution of your originals, since a marketplace where 80% of listings never change photo is a very different storage problem from one where sellers re-shoot weekly.

Your mileage may vary on the exact sizes — 96, 320 and 1024 are my starting point for a review list, a search card and a product page, not a law. The part I'd keep in any variant of this design is the boundary: bytes go browser-to-bucket, derivation is bounded work in a worker, and one row decides what's live.

## References

- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition
- https://www.rfc-editor.org/rfc/rfc6266
- https://sharp.pixelplumbing.com/api-resize
- https://firebase.google.com/docs/storage
