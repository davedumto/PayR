import { z } from "zod";

import { isSecureServiceUrl } from "@/env.edge";

/**
 * Client for the Vellar x402 facilitator: GET /supported, POST /verify, POST /settle.
 *
 * The response body decides every outcome. HTTP status is never the decision on
 * its own (docs: "Always branch on the response body fields"). Every network
 * failure fails closed. An ambiguous settle is treated as terminal, so it is
 * never retried.
 */

export const FACILITATOR_BODY_MAX_BYTES = 32 * 1024;

export type FacilitatorFetch = (input: string, init: RequestInit) => Promise<Response>;

export type VerifyOutcome =
  | { readonly kind: "valid"; readonly payer?: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "paused" }
  | { readonly kind: "unavailable" };

export type SettleOutcome =
  | { readonly kind: "settled"; readonly transaction: string; readonly payer?: string }
  | { readonly kind: "retry_safe"; readonly reason: string }
  | {
      readonly kind: "terminal_charged";
      readonly transaction: string | null;
      readonly reason: string;
    }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "paused" }
  | { readonly kind: "invalid"; readonly reason: string };

/** What the client observed from one settle call. "unreachable" means no response. */
export type SettleObservation =
  { readonly status: number; readonly body: unknown } | { readonly unreachable: true };

const verifyBodySchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});

const settleBodySchema = z.object({
  success: z.boolean(),
  transaction: z.string(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
});

const refusalBodySchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
});

const INVALID_PAYLOAD_PREFIX = "invalid_exact_stellar_payload_";

/** Maps one verify observation to an outcome. Anything unexpected is unavailable. */
export function classifyVerify(observation: SettleObservation): VerifyOutcome {
  if ("unreachable" in observation) {
    return { kind: "unavailable" };
  }
  const refusal = refusalBodySchema.safeParse(observation.body);
  if (refusal.success && refusal.data.error === "service_paused") {
    return { kind: "paused" };
  }
  const parsed = verifyBodySchema.safeParse(observation.body);
  if (!parsed.success) {
    return { kind: "unavailable" };
  }
  if (parsed.data.isValid) {
    return parsed.data.payer === undefined
      ? { kind: "valid" }
      : { kind: "valid", payer: parsed.data.payer };
  }
  return { kind: "invalid", reason: parsed.data.invalidReason ?? "unspecified" };
}

/**
 * Maps one settle observation to exactly one outcome, using the body rules from
 * the Vellar error table. A body that cannot be read as a settle result is
 * ambiguous, and an ambiguous settle is terminal: it is never retried.
 */
export function classifySettle(observation: SettleObservation): SettleOutcome {
  if ("unreachable" in observation) {
    return { kind: "terminal_charged", transaction: null, reason: "ambiguous: no response" };
  }
  const refusal = refusalBodySchema.safeParse(observation.body);
  if (refusal.success) {
    if (refusal.data.error === "service_paused") {
      return { kind: "paused" };
    }
    if (refusal.data.error === "settlement_refused") {
      return { kind: "refused", reason: refusal.data.reason ?? "unspecified" };
    }
    if (refusal.data.error === "invalid_payload") {
      return { kind: "invalid", reason: "invalid_payload" };
    }
  }
  const parsed = settleBodySchema.safeParse(observation.body);
  if (!parsed.success) {
    return {
      kind: "terminal_charged",
      transaction: null,
      reason: "ambiguous: unreadable settle body",
    };
  }
  const { success, transaction, errorReason, payer } = parsed.data;
  if (success) {
    if (transaction !== "") {
      return payer === undefined
        ? { kind: "settled", transaction }
        : { kind: "settled", transaction, payer };
    }
    return {
      kind: "terminal_charged",
      transaction: null,
      reason: "ambiguous: success without a transaction",
    };
  }
  if (transaction !== "") {
    return { kind: "terminal_charged", transaction, reason: errorReason ?? "unspecified" };
  }
  if (errorReason === "fee_exceeds_maximum") {
    return { kind: "refused", reason: errorReason };
  }
  if (errorReason?.startsWith(INVALID_PAYLOAD_PREFIX)) {
    return { kind: "invalid", reason: errorReason };
  }
  return { kind: "retry_safe", reason: errorReason ?? "unspecified" };
}

/** Reads a response body up to a byte cap. Returns undefined if the cap is exceeded. */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export type FacilitatorClientOptions = {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetch?: FacilitatorFetch;
};

export class FacilitatorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FacilitatorFetch;

  constructor(options: FacilitatorClientOptions) {
    if (!isSecureServiceUrl(options.baseUrl)) {
      throw new TypeError("facilitator base URL must be an absolute https URL");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async verify(body: unknown): Promise<VerifyOutcome> {
    return classifyVerify(await this.post("/verify", body));
  }

  async settle(body: unknown): Promise<SettleOutcome> {
    return classifySettle(await this.post("/settle", body));
  }

  private async post(path: string, body: unknown): Promise<SettleObservation> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return await this.observe(response);
    } catch {
      return { unreachable: true };
    }
  }

  private async observe(response: Response): Promise<SettleObservation> {
    if (response.status >= 300 && response.status < 400) {
      return { unreachable: true };
    }
    const text = await readCapped(response, FACILITATOR_BODY_MAX_BYTES);
    if (text === undefined) {
      return { unreachable: true };
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: text };
    }
  }
}
