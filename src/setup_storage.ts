import { infrai } from "./infrai_storage.js";

const bucket = process.env.ORDER_ASSET_BUCKET ?? "commerce-order-assets";
await infrai.storage.bucket.create(bucket);
console.log(`Storage bucket ready: ${bucket}`);
