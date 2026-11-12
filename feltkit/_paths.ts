/**
 * get-it's fulfillment paths (a helper module, not functions): its frozen, active service contracts.
 * `signals` are the whole words that let a customer choose a service from their own description;
 * they never choose it for them.
 */
import { CONTRACT } from "./_guards.js";

export const PATHS = [
  {
    service: CONTRACT.key,
    title: CONTRACT.contract.title,
    signals: ["bill", "bills", "invoice", "invoices", "payable", "payables", "accounts payable", "supplier bills", "vendor bills"],
  },
] as const;
