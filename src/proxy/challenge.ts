import { z } from "zod";

import type { ProxyConfig } from "@/proxy/config";

/**
 * x402 v2 wire format for the exact scheme. Headers carry base64-encoded JSON.
 *
 * PAYMENT-REQUIRED   the 402 challenge, sent by the proxy
 * PAYMENT-SIGNATURE  the buyer's retry, carrying a signed payload
 * PAYMENT-RESPONSE   the settlement receipt, sent only after a successful settle
 *
 * The signed payload is treated as opaque. This module checks only the envelope
 * and the accepted terms. Those terms are compared to the server's own
 * requirements in flow.ts.
 */

export const X402_VERSION = 2;
export const PAYMENT_SIGNATURE_MAX_BYTES = 16 * 1024;
export const CHALLENGE_MAX_TIMEOUT_SECONDS = 120;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export type PaymentRequirements = {
  readonly scheme: "exact";
  readonly network: ProxyConfig["network"];
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly areFeesSponsored: true };
};

export type PaymentRequired = {
  readonly x402Version: typeof X402_VERSION;
  readonly error?: string;
  readonly resource: {
    readonly url: string;
    readonly description: string;
    readonly mimeType: string;
  };
  readonly accepts: readonly PaymentRequirements[];
};

/** The terms this proxy requires for one seller. The flow compares against these. */
export function requirementsFor(config: ProxyConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    amount: config.priceBaseUnits,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: CHALLENGE_MAX_TIMEOUT_SECONDS,
    extra: { areFeesSponsored: true },
  };
}

export function buildPaymentRequired(
  config: ProxyConfig,
  resourceUrl: string,
  error?: string,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error !== undefined ? { error } : {}),
    resource: { url: resourceUrl, description: config.description, mimeType: "application/json" },
    accepts: [requirementsFor(config)],
  };
}

/** Encodes a JSON-serialisable value as the base64 header form used by x402. */
export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const requirementsSchema = z.object({
  scheme: z.string().min(1).max(64),
  network: z.string().min(1).max(64),
  amount: z.string().min(1).max(64),
  asset: z.string().min(1).max(128),
  payTo: z.string().min(1).max(128),
  maxTimeoutSeconds: z.number().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const signatureSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  accepted: requirementsSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type ParsedSignature = z.output<typeof signatureSchema>;

export type SignatureParse =
  | { readonly ok: true; readonly signature: ParsedSignature; readonly header: string }
  | {
      readonly ok: false;
      readonly reason: "too-large" | "malformed-base64" | "malformed-json" | "malformed-envelope";
    };

/**
 * Parses the buyer's PAYMENT-SIGNATURE header. Rejects anything over 16 KiB
 * before decoding, so a large header costs no parsing work.
 */
export function parsePaymentSignature(header: string): SignatureParse {
  if (Buffer.byteLength(header, "utf8") > PAYMENT_SIGNATURE_MAX_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  if (header.length === 0 || !BASE64_PATTERN.test(header)) {
    return { ok: false, reason: "malformed-base64" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  const envelope = signatureSchema.safeParse(decoded);
  if (!envelope.success) {
    return { ok: false, reason: "malformed-envelope" };
  }
  return { ok: true, signature: envelope.data, header };
}
