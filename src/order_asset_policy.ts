import { z } from "zod";

export const orderStateSchema = z.enum([
  "checkout_pending",
  "paid",
  "fulfillment_in_progress",
  "fulfilled"
]);
export const assetKindSchema = z.enum([
  "checkout_attachment",
  "fulfillment_proof",
  "receipt",
  "customer_update"
]);

export type OrderState = z.infer<typeof orderStateSchema>;
export type AssetKind = z.infer<typeof assetKindSchema>;

const allowedAssets: Record<OrderState, readonly AssetKind[]> = {
  checkout_pending: ["checkout_attachment"],
  paid: ["receipt", "customer_update"],
  fulfillment_in_progress: ["fulfillment_proof", "receipt", "customer_update"],
  fulfilled: ["fulfillment_proof", "receipt", "customer_update"]
};

export function canAttachAsset(state: OrderState, kind: AssetKind): boolean {
  return allowedAssets[state].includes(kind);
}

export function objectKey(orderId: string, kind: AssetKind, fileName: string): string {
  const safeName = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `orders/${orderId}/${kind}/${safeName}`;
}
