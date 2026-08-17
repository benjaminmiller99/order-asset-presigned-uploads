import assert from "node:assert/strict";
import test from "node:test";
import { canAttachAsset, objectKey } from "../src/order_asset_policy.js";

test("a receipt waits for payment while checkout evidence does not", () => {
  assert.equal(canAttachAsset("checkout_pending", "receipt"), false);
  assert.equal(canAttachAsset("checkout_pending", "checkout_attachment"), true);
  assert.equal(canAttachAsset("paid", "receipt"), true);
});

test("fulfillment and customer updates remain attachable after fulfillment", () => {
  assert.equal(canAttachAsset("fulfilled", "fulfillment_proof"), true);
  assert.equal(canAttachAsset("fulfilled", "customer_update"), true);
  assert.equal(
    objectKey("ord_1042", "fulfillment_proof", "Front Door.JPG"),
    "orders/ord_1042/fulfillment_proof/front-door.jpg"
  );
});
