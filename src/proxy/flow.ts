import { canonicalHash } from "@/proxy/canonical";
import { parseProxyConfig, type ProxyConfig } from "@/proxy/config";
import { buildUpstreamUrl } from "@/proxy/url";
import { runGuard } from "@/proxy/guard";
import {
  buildPaymentRequired,
  type ParsedSignature,
  encodeHeader,
  parsePaymentSignature,
  requirementsFor,
  type PaymentRequirements,
} from "@/proxy/challenge";
import type { SettleOutcome, VerifyOutcome } from "@/proxy/facilitator";

/**
 * The paid-request state machine. Every dependency is injected, so the whole
 * money path runs in tests with no network.
 *
 * Invariants (each has a named test in flow.test.ts):
 *   I1  The upstream body is returned only after /settle succeeds.
 *   I2  /settle is called only after /verify passes AND the upstream returns 2xx.
 *   I3  One PAYMENT-SIGNATURE reaches the upstream at most once. A duplicate gets 409.
 *   I4  Failure to read config, reach the facilitator, or write the lock fails closed.
 *   I5  The stored config is re-validated on every read.
 *   I6  Retry decisions follow the classified settle outcome, and settle is never repeated.
 *   I7  The flow holds no key that can move funds. Its only inputs are injected ports.
 */

export const LOCK_TTL_SECONDS = 300;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const NEVER_RETURN_RESPONSE = new Set(["set-cookie", "content-length"]);

export type Headers = Readonly<Record<string, string>>;

export type ProxyRequest = {
  readonly proxyId: string;
  readonly method: string;
  /** Path after /proxy/{id}, starting with "/", including any query string. */
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  /** Absolute URL of this proxy route, used as the challenge's resource URL. */
  readonly resourceUrl: string;
};

export type ProxyResponse = {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
};

export type UpstreamRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array | undefined;
};

export type UpstreamResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
};

export interface ConfigStore {
  /** Returns the stored value, or null if absent. May throw on a KV error. */
  get(id: string): Promise<unknown>;
}

export interface StateKv {
  /** SET NX with a TTL. Resolves true if the key was set, false if it existed. May throw. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Removes a key. Used to release a lock when no upstream call happened. */
  delete(key: string): Promise<void>;
}

export interface FacilitatorPort {
  verify(body: unknown): Promise<VerifyOutcome>;
  settle(body: unknown): Promise<SettleOutcome>;
}

export interface UpstreamFetcher {
  /**
   * Performs the request. It must not follow redirects, must stop reading after
   * maxBytes, and must reject on timeout. The flow treats a 3xx as failure.
   */
  fetch(
    request: UpstreamRequest,
    limits: { readonly timeoutMs: number; readonly maxBytes: number },
  ): Promise<UpstreamResponse>;
}

/** Logs only identifiers and classified reasons. Never a signature or a secret. */
export interface ProxyLogger {
  warn(event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

export const noopLogger: ProxyLogger = { warn: () => undefined };

export interface Clock {
  now(): number;
}

export type ScanInput = {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
};

export type ScanVerdict =
  { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface PayloadScanner {
  scan(input: ScanInput): Promise<ScanVerdict>;
}

export type FlowDeps = {
  readonly configs: ConfigStore;
  readonly state: StateKv;
  readonly facilitator: FacilitatorPort;
  readonly upstream: UpstreamFetcher;
  readonly clock: Clock;
  readonly scanner?: PayloadScanner;
  readonly logger?: ProxyLogger;
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): ProxyResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function challenge(
  config: ProxyConfig,
  request: ProxyRequest,
  error: string,
  extra: Record<string, unknown> = {},
): ProxyResponse {
  const required = buildPaymentRequired(config, request.resourceUrl, error);
  return json(402, { ...required, ...extra }, { "payment-required": encodeHeader(required) });
}

function unavailable(status: number, error: string, retryAfter: number): ProxyResponse {
  return json(status, { error }, { "retry-after": String(retryAfter) });
}

type LockState = { readonly key: string; upstreamCalled: boolean };

async function releaseLock(deps: FlowDeps, key: string): Promise<void> {
  try {
    await deps.state.delete(key);
  } catch {
    // The lock then expires with its TTL. Failing closed here is safe: it only delays a retry.
  }
}

function termsMatch(
  accepted: PaymentRequirements | { readonly [k: string]: unknown },
  required: PaymentRequirements,
): boolean {
  const a = accepted as Partial<Record<keyof PaymentRequirements, unknown>> & {
    readonly extra?: Record<string, unknown>;
  };
  return (
    a.scheme === required.scheme &&
    a.network === required.network &&
    a.amount === required.amount &&
    a.asset === required.asset &&
    a.payTo === required.payTo &&
    a.maxTimeoutSeconds === required.maxTimeoutSeconds &&
    a.extra?.areFeesSponsored === true
  );
}

/** Header names listed in a Connection header. Those are hop-by-hop too. */
function connectionTokensOf(headers: Headers): Set<string> {
  const tokens = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed.length > 0) tokens.add(trimmed);
    }
  }
  return tokens;
}

/** Drops Set-Cookie and hop-by-hop headers from the upstream response. */
export function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const connectionTokens = connectionTokensOf(headers);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (NEVER_RETURN_RESPONSE.has(key) || HOP_BY_HOP.has(key) || connectionTokens.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function loadConfig(
  deps: FlowDeps,
  request: ProxyRequest,
): Promise<{ config: ProxyConfig } | { response: ProxyResponse }> {
  let raw: unknown;
  try {
    raw = await deps.configs.get(request.proxyId);
  } catch {
    return { response: unavailable(503, "config_unavailable", 30) };
  }
  if (raw === null || raw === undefined) {
    return { response: json(404, { error: "unknown_proxy" }) };
  }
  const parsed = parseProxyConfig(raw);
  if (!parsed.ok) {
    return { response: unavailable(503, "config_invalid", 30) };
  }
  if (parsed.config.status === "paused") {
    return { response: unavailable(503, "seller_paused", 60) };
  }
  return { config: parsed.config };
}

/** Scanner budget. A scanner that does not answer in time blocks the request. */
export const SCANNER_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("scanner timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs one paid request through the state machine. Never throws. */
export async function handlePaidRequest(
  request: ProxyRequest,
  deps: FlowDeps,
): Promise<ProxyResponse> {
  const loaded = await loadConfig(deps, request);
  if ("response" in loaded) {
    return loaded.response;
  }
  const { config } = loaded;

  // The guard runs first, before any payment logic. I8: a guard failure never reaches
  // the upstream and never triggers a settle.
  const guard = runGuard({
    method: request.method,
    path: request.path,
    headers: request.headers,
    body: request.body,
    config: {
      allowedMethods: config.allowedMethods,
      maxRequestBytes: config.maxRequestBytes,
      allowedContentTypes: config.allowedContentTypes,
    },
  });
  if (!guard.ok) {
    return json(
      guard.status,
      { error: "request_rejected", reason: guard.reason },
      guard.status === 405 ? { allow: config.allowedMethods.join(", ") } : {},
    );
  }
  const target = buildUpstreamUrl(config.targetUrl, request.path);
  if (!target.ok) {
    return json(400, { error: "invalid_path", reason: target.reason });
  }

  const signatureHeader = request.headers["payment-signature"];
  if (signatureHeader === undefined) {
    return challenge(config, request, "payment_required");
  }

  const parsed = parsePaymentSignature(signatureHeader);
  if (!parsed.ok) {
    if (parsed.reason === "too-large") {
      return json(413, { error: "payment_signature_too_large" });
    }
    return challenge(config, request, "invalid_payment_signature");
  }

  const required = requirementsFor(config);
  if (!termsMatch(parsed.signature.accepted, required)) {
    return challenge(config, request, "payment_terms_mismatch");
  }

  // I3 and B3: one payment reaches the upstream at most once. The lock key is the
  // canonical hash of the signed payload, so re-encoded copies of the same payment collide.
  let lockKey: string;
  try {
    lockKey = `lock:${canonicalHash(parsed.signature.payload)}`;
  } catch {
    return challenge(config, request, "invalid_payment_signature");
  }
  let acquired: boolean;
  try {
    acquired = await deps.state.setNx(lockKey, "1", LOCK_TTL_SECONDS);
  } catch {
    return unavailable(503, "state_unavailable", 30);
  }
  if (!acquired) {
    return json(409, { error: "duplicate_payment_signature" });
  }
  const lock: LockState = { key: lockKey, upstreamCalled: false };
  try {
    return await runAfterLock(
      config,
      request,
      parsed.signature,
      required,
      target.url,
      guard.headers,
      deps,
      lock,
    );
  } finally {
    // B3: release the lock when no upstream call happened, so a legitimate retry is not answered 409.
    if (!lock.upstreamCalled) {
      await releaseLock(deps, lock.key);
    }
  }
}

/** Everything after the replay lock is taken. The caller releases the lock if no upstream call happened. */
async function runAfterLock(
  config: ProxyConfig,
  request: ProxyRequest,
  signature: ParsedSignature,
  required: PaymentRequirements,
  target: URL,
  forwardHeaders: Readonly<Record<string, string>>,
  deps: FlowDeps,
  lock: LockState,
): Promise<ProxyResponse> {
  const facilitatorRequest = (): {
    x402Version: 2;
    paymentPayload: ParsedSignature;
    paymentRequirements: PaymentRequirements;
  } => ({
    x402Version: 2,
    paymentPayload: signature,
    paymentRequirements: required,
  });

  // I4: any facilitator failure at verify stops here, before any upstream call.
  let verdict: VerifyOutcome;
  try {
    verdict = await deps.facilitator.verify(facilitatorRequest());
  } catch {
    verdict = { kind: "unavailable" };
  }
  if (verdict.kind === "unavailable") {
    return unavailable(503, "facilitator_unavailable", 15);
  }
  if (verdict.kind === "paused") {
    return unavailable(503, "facilitator_paused", 60);
  }
  if (verdict.kind === "invalid") {
    return challenge(config, request, "payment_invalid", { reason: verdict.reason });
  }

  if (deps.scanner) {
    let scan;
    try {
      scan = await withTimeout(
        deps.scanner.scan({
          method: request.method,
          path: request.path,
          headers: forwardHeaders,
          body: request.body,
        }),
        SCANNER_TIMEOUT_MS,
      );
    } catch {
      // Fail closed: a scanner error blocks the request.
      return unavailable(503, "scanner_unavailable", 30);
    }
    if (!scan.allow) {
      return json(403, { error: "request_blocked" });
    }
  }

  // I2: the upstream must succeed before settle is attempted.
  let upstream: UpstreamResponse;
  try {
    lock.upstreamCalled = true;
    upstream = await deps.upstream.fetch(
      {
        method: request.method,
        url: target.toString(),
        headers: forwardHeaders,
        body: request.body.byteLength > 0 ? request.body : undefined,
      },
      { timeoutMs: config.upstreamTimeoutMs, maxBytes: config.maxResponseBytes },
    );
  } catch (error) {
    return isTimeout(error)
      ? json(504, { error: "upstream_timeout" })
      : json(502, { error: "upstream_failed" });
  }
  if (upstream.body.byteLength > config.maxResponseBytes) {
    return json(502, { error: "upstream_too_large" });
  }
  if (upstream.status < 200 || upstream.status > 299) {
    return json(502, { error: "upstream_error", upstreamStatus: upstream.status });
  }

  // I6: settle exactly once. The classified outcome decides what the buyer sees.
  let outcome: SettleOutcome;
  try {
    outcome = await deps.facilitator.settle(facilitatorRequest());
  } catch {
    // An unreadable settle may have moved funds, so it is terminal. Logged, never retried.
    (deps.logger ?? noopLogger).warn("settle_unknown", { proxy_id: config.id });
    return json(502, { error: "settlement_unknown", transaction: null });
  }
  if (outcome.kind === "terminal_charged" && outcome.reason.startsWith("ambiguous")) {
    // B2: a timed-out or unreadable settle may have been submitted. Log it, never treat it as nothing spent.
    (deps.logger ?? noopLogger).warn("settle_ambiguous", {
      proxy_id: config.id,
      reason: outcome.reason,
    });
  }

  switch (outcome.kind) {
    case "settled": {
      // I1: the upstream body is returned only here.
      const receipt = encodeHeader({
        success: true,
        transaction: outcome.transaction,
        network: config.network,
        ...(outcome.payer !== undefined ? { payer: outcome.payer } : {}),
        timestamp: deps.clock.now(),
      });
      return {
        status: upstream.status,
        headers: { ...sanitizeResponseHeaders(upstream.headers), "payment-response": receipt },
        body: upstream.body,
      };
    }
    case "retry_safe":
      // Nothing was spent. The buyer must sign again, so the 402 is fresh.
      return challenge(config, request, "settlement_failed_sign_again", { reason: outcome.reason });
    case "terminal_charged":
      // Fees were charged. Terminal: no retry hint, no body, the hash is surfaced.
      return json(502, { error: "settlement_failed_charged", transaction: outcome.transaction });
    case "refused":
      return unavailable(503, "settlement_refused", 60);
    case "paused":
      return unavailable(503, "facilitator_paused", 60);
    case "invalid":
      return challenge(config, request, "payment_invalid", { reason: outcome.reason });
  }
}
