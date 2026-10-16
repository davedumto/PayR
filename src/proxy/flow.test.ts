import { describe, expect, it } from "vitest";

import { parseProxyConfig, type ProxyConfig } from "@/proxy/config";
import { encodeHeader, requirementsFor } from "@/proxy/challenge";
import type { SettleOutcome, VerifyOutcome } from "@/proxy/facilitator";
import { runGuard } from "@/proxy/guard";
import {
  type ConfigStore,
  type FacilitatorPort,
  handlePaidRequest,
  type FlowDeps,
  type PayloadScanner,
  type ProxyRequest,
  type ProxyResponse,
  SCANNER_TIMEOUT_MS,
  sanitizeResponseHeaders,
  type StateKv,
  type UpstreamFetcher,
  type UpstreamRequest,
  type UpstreamResponse,
} from "@/proxy/flow";

const PAY_TO = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const ASSET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const UPSTREAM_SECRET = "UPSTREAM-SECRET-BODY";
const decoder = new TextDecoder();

function config(overrides: Record<string, unknown> = {}): ProxyConfig {
  const result = parseProxyConfig({
    version: 1,
    id: "weather-api",
    status: "active",
    targetUrl: "https://api.example.com/v1",
    priceBaseUnits: "500000",
    asset: ASSET,
    payTo: PAY_TO,
    network: "stellar:testnet",
    description: "Hourly forecast",
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(result.issues.join("; "));
  }
  return result.config;
}

function signatureFor(cfg: ProxyConfig, overrides: Record<string, unknown> = {}): string {
  return encodeHeader({
    x402Version: 2,
    accepted: requirementsFor(cfg),
    payload: { authorization: "opaque" },
    ...overrides,
  });
}

function request(
  cfg: ProxyConfig,
  headers: Record<string, string> = {},
  extra: Partial<ProxyRequest> = {},
): ProxyRequest {
  return {
    proxyId: cfg.id,
    method: "GET",
    path: "/forecast?city=lisbon",
    headers,
    body: new Uint8Array(),
    resourceUrl: "https://proxy.example.test/proxy/weather-api/forecast",
    ...extra,
  };
}

type Harness = {
  deps: FlowDeps;
  calls: { verify: number; settle: number; upstream: UpstreamRequest[]; scan: number };
  setConfig(value: unknown): void;
  failConfigRead(): void;
  failStateWrite(): void;
  verifyOutcome: VerifyOutcome | (() => Promise<VerifyOutcome>);
  settleOutcome: SettleOutcome | (() => Promise<SettleOutcome>);
  upstreamResult: UpstreamResponse | Error | (() => Promise<UpstreamResponse>);
  scanner?: PayloadScanner;
};

function harness(cfg: ProxyConfig): Harness {
  let stored: unknown = cfg;
  let configFails = false;
  let stateFails = false;
  const locks = new Set<string>();
  const calls = { verify: 0, settle: 0, upstream: [] as UpstreamRequest[], scan: 0 };
  const h = {} as Harness;
  const configs: ConfigStore = {
    get: async () => {
      if (configFails) throw new Error("KV unavailable");
      return stored;
    },
  };
  const state: StateKv = {
    setNx: async (key) => {
      if (stateFails) throw new Error("KV unavailable");
      if (locks.has(key)) return false;
      locks.add(key);
      return true;
    },
    delete: async (key) => {
      locks.delete(key);
    },
  };
  const facilitator: FacilitatorPort = {
    verify: async () => {
      calls.verify += 1;
      return typeof h.verifyOutcome === "function" ? h.verifyOutcome() : h.verifyOutcome;
    },
    settle: async () => {
      calls.settle += 1;
      return typeof h.settleOutcome === "function" ? h.settleOutcome() : h.settleOutcome;
    },
  };
  const upstream: UpstreamFetcher = {
    fetch: async (req) => {
      calls.upstream.push(req);
      if (typeof h.upstreamResult === "function") return h.upstreamResult();
      if (h.upstreamResult instanceof Error) throw h.upstreamResult;
      return h.upstreamResult;
    },
  };
  h.calls = calls;
  h.deps = {
    configs,
    state,
    facilitator,
    upstream,
    clock: { now: () => 1_700_000_000_000 },
    get scanner() {
      return h.scanner;
    },
  } as FlowDeps;
  h.setConfig = (value) => {
    stored = value;
  };
  h.failConfigRead = () => {
    configFails = true;
  };
  h.failStateWrite = () => {
    stateFails = true;
  };
  h.verifyOutcome = { kind: "valid", payer: "GPAYER" };
  h.settleOutcome = { kind: "settled", transaction: "txhash" };
  h.upstreamResult = {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": "s=1" },
    body: new TextEncoder().encode(UPSTREAM_SECRET),
  };
  return h;
}

function bodyText(response: { body: Uint8Array }): string {
  return decoder.decode(response.body);
}

function paidHeaders(
  cfg: ProxyConfig,
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  return { "payment-signature": signatureFor(cfg, overrides) };
}

describe("unpaid and malformed requests (no facilitator or upstream call)", () => {
  it("unpaid request gets 402 with a PAYMENT-REQUIRED challenge", async () => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg), h.deps);
    expect(response.status).toBe(402);
    const challengeHeader = response.headers["payment-required"];
    expect(challengeHeader).toBeDefined();
    const decoded = JSON.parse(Buffer.from(challengeHeader!, "base64").toString("utf8"));
    expect(decoded.accepts[0].amount).toBe("500000");
    expect(decoded.accepts[0].payTo).toBe(PAY_TO);
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.settle).toBe(0);
  });

  it("unknown proxy id gets 404", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.setConfig(null);
    expect((await handlePaidRequest(request(cfg), h.deps)).status).toBe(404);
  });

  it("a disallowed method gets 405 with an Allow header", async () => {
    const cfg = config({ allowedMethods: ["GET"] });
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, {}, { method: "DELETE" }), h.deps);
    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe("GET");
  });

  it("a request body over the limit gets 413 before any payment check", async () => {
    const cfg = config({
      maxRequestBytes: 4,
      allowedMethods: ["GET", "POST"],
      sideEffectsAcknowledged: true,
    });
    const h = harness(cfg);
    const response = await handlePaidRequest(
      request(cfg, {}, { method: "POST", body: new Uint8Array(5) }),
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(h.calls.verify).toBe(0);
  });

  it("a PAYMENT-SIGNATURE over 16 KiB gets 413 without decoding", async () => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(
      request(cfg, { "payment-signature": "A".repeat(16 * 1024 + 1) }),
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(h.calls.verify).toBe(0);
  });

  it("a malformed PAYMENT-SIGNATURE gets a fresh 402 and no upstream call", async () => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(
      request(cfg, { "payment-signature": "not base64!" }),
      h.deps,
    );
    expect(response.status).toBe(402);
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.verify).toBe(0);
  });

  it("terms that differ from the seller's (tampered amount) get a 402 and no verify call", async () => {
    const cfg = config();
    const h = harness(cfg);
    const tampered = { accepted: { ...requirementsFor(cfg), amount: "1" } };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg, tampered)), h.deps);
    expect(response.status).toBe(402);
    expect(JSON.parse(bodyText(response)).error).toBe("payment_terms_mismatch");
    expect(h.calls.verify).toBe(0);
  });
});

describe("I5 and I4: the stored config is re-validated, and a bad read fails closed", () => {
  it("I5: a stored config that no longer validates gets 503 and no upstream call", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.setConfig({ ...cfg, targetUrl: "https://169.254.169.254/latest" });
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(JSON.parse(bodyText(response)).error).toBe("config_invalid");
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.verify).toBe(0);
  });

  it("I5: a stored config with an extra key is rejected", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.setConfig({ ...cfg, adminOverride: true });
    expect((await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps)).status).toBe(503);
  });

  it("I4: a KV error reading the config fails closed with 503 and no settle", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.failConfigRead();
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(h.calls.settle).toBe(0);
    expect(h.calls.upstream).toHaveLength(0);
  });

  it("a paused seller gets 503 seller_paused and no facilitator call", async () => {
    const cfg = config({ status: "paused" });
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(JSON.parse(bodyText(response)).error).toBe("seller_paused");
    expect(h.calls.verify).toBe(0);
  });
});

describe("I2: settle only after verify passes AND the upstream returns 2xx", () => {
  it("I2: a verify that is invalid never reaches the upstream or settle", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.verifyOutcome = { kind: "invalid", reason: "bad_sig" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(402);
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.settle).toBe(0);
  });

  it("I2: an upstream 500 is not settled, so the buyer is not charged", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = { status: 500, headers: {}, body: new TextEncoder().encode("boom") };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(502);
    expect(JSON.parse(bodyText(response)).error).toBe("upstream_error");
    expect(h.calls.settle).toBe(0);
    expect(h.calls.upstream).toHaveLength(1);
  });

  it("I2: an upstream 3xx redirect is treated as failure and not settled", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = {
      status: 302,
      headers: { location: "https://elsewhere.test" },
      body: new Uint8Array(),
    };
    expect((await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps)).status).toBe(502);
    expect(h.calls.settle).toBe(0);
  });

  it("I2: an upstream timeout is a 504 and is not settled", async () => {
    const cfg = config();
    const h = harness(cfg);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    h.upstreamResult = timeout;
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(504);
    expect(JSON.parse(bodyText(response)).error).toBe("upstream_timeout");
    expect(h.calls.settle).toBe(0);
  });

  it("an upstream network failure is a 502 and is not settled", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = new Error("ECONNRESET");
    expect((await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps)).status).toBe(502);
    expect(h.calls.settle).toBe(0);
  });

  it("a response body over maxResponseBytes is a 502 and is not settled", async () => {
    const cfg = config({ maxResponseBytes: 4 });
    const h = harness(cfg);
    h.upstreamResult = { status: 200, headers: {}, body: new TextEncoder().encode("too long") };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(502);
    expect(JSON.parse(bodyText(response)).error).toBe("upstream_too_large");
    expect(h.calls.settle).toBe(0);
  });
});

describe("I3: a PAYMENT-SIGNATURE reaches the upstream at most once", () => {
  it("I3: two concurrent requests with one signature make one upstream call; the second gets 409", async () => {
    const cfg = config();
    const h = harness(cfg);
    const headers = paidHeaders(cfg);
    const [first, second] = await Promise.all([
      handlePaidRequest(request(cfg, headers), h.deps),
      handlePaidRequest(request(cfg, headers), h.deps),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(h.calls.upstream).toHaveLength(1);
    expect(h.calls.settle).toBe(1);
  });

  it("I3: replaying a completed signature gets 409 and never reaches the upstream again", async () => {
    const cfg = config();
    const h = harness(cfg);
    const headers = paidHeaders(cfg);
    expect((await handlePaidRequest(request(cfg, headers), h.deps)).status).toBe(200);
    expect((await handlePaidRequest(request(cfg, headers), h.deps)).status).toBe(409);
    expect(h.calls.upstream).toHaveLength(1);
  });

  it("I4: a KV error writing the replay lock fails closed with 503", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.failStateWrite();
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(h.calls.verify).toBe(0);
    expect(h.calls.upstream).toHaveLength(0);
  });
});

describe("I1: the upstream body is returned only after settle succeeds", () => {
  it("I1: a settled payment returns the upstream body with a PAYMENT-RESPONSE receipt", async () => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(200);
    expect(bodyText(response)).toBe(UPSTREAM_SECRET);
    const receipt = JSON.parse(
      Buffer.from(response.headers["payment-response"]!, "base64").toString("utf8"),
    );
    expect(receipt).toEqual({
      success: true,
      transaction: "txhash",
      network: "stellar:testnet",
      timestamp: 1_700_000_000_000,
    });
  });

  it.each([
    ["retry_safe", { kind: "retry_safe", reason: "x" } as SettleOutcome],
    [
      "terminal_charged",
      { kind: "terminal_charged", transaction: "h", reason: "x" } as SettleOutcome,
    ],
    ["refused", { kind: "refused", reason: "sponsor_balance_low" } as SettleOutcome],
    ["paused", { kind: "paused" } as SettleOutcome],
    ["invalid", { kind: "invalid", reason: "x" } as SettleOutcome],
  ])("I1: a %s settle outcome never returns the upstream body", async (_name, outcome) => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = outcome;
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(bodyText(response)).not.toContain(UPSTREAM_SECRET);
    expect(response.headers["payment-response"]).toBeUndefined();
  });

  it("I1: an upstream that answered 200 but whose settle was unreadable does not leak the body", async () => {
    const cfg = config();
    const h = harness(cfg);
    const deps = {
      ...h.deps,
      facilitator: {
        verify: async () => ({ kind: "valid" as const }),
        settle: async () => {
          throw new Error("unreadable");
        },
      },
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
    expect(bodyText(response)).not.toContain(UPSTREAM_SECRET);
    expect(response.status).toBe(502);
  });
});

describe("I6: retry decisions follow the classified settle outcome; settle is never repeated", () => {
  it("I6: retry_safe returns a fresh 402 with the settle reason, and does not retry settle", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = { kind: "retry_safe", reason: "settle_exact_stellar_transaction_failed" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(402);
    expect(response.headers["payment-required"]).toBeDefined();
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(h.calls.settle).toBe(1);
  });

  it("I6: terminal_charged has no retry hint and surfaces the transaction hash", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = { kind: "terminal_charged", transaction: "deadbeef", reason: "x" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(502);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(JSON.parse(bodyText(response))).toEqual({
      error: "settlement_failed_charged",
      transaction: "deadbeef",
    });
    expect(h.calls.settle).toBe(1);
  });

  it("I6: an unreachable settle is terminal and is not retried", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = {
      kind: "terminal_charged",
      transaction: null,
      reason: "ambiguous: no response",
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(502);
    expect(h.calls.settle).toBe(1);
  });

  it("I6: a settle that throws is treated as settlement_unknown and not retried", async () => {
    const cfg = config();
    const h = harness(cfg);
    const deps = {
      ...h.deps,
      facilitator: {
        verify: async () => ({ kind: "valid" as const }),
        settle: async () => {
          throw new Error("socket hang up");
        },
      },
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
    expect(response.status).toBe(502);
    expect(JSON.parse(bodyText(response)).error).toBe("settlement_unknown");
  });

  it("refused settle gives 503 with Retry-After and no body", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = { kind: "refused", reason: "spend_ceiling" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(bodyText(response)).not.toContain(UPSTREAM_SECRET);
  });

  it("a paused facilitator at settle gives 503 with Retry-After", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = { kind: "paused" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("60");
  });
});

describe("I4: facilitator failures at verify fail closed before any upstream call", () => {
  it("I4: facilitator unavailable at verify gives 503 with Retry-After and no upstream call", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.verifyOutcome = { kind: "unavailable" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("15");
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.settle).toBe(0);
  });

  it("I4: a facilitator that throws at verify is treated as unavailable", async () => {
    const cfg = config();
    const h = harness(cfg);
    const deps = {
      ...h.deps,
      facilitator: {
        verify: async () => {
          throw new Error("down");
        },
        settle: async () => ({ kind: "settled" as const, transaction: "x" }),
      },
    };
    expect((await handlePaidRequest(request(cfg, paidHeaders(cfg)), deps)).status).toBe(503);
  });

  it("a paused facilitator at verify gives 503 with Retry-After and no upstream call", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.verifyOutcome = { kind: "paused" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(h.calls.upstream).toHaveLength(0);
  });
});

describe("scanner: called before forwarding, fail-closed", () => {
  it("a scanner that blocks returns 403 and does not settle", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.scanner = { scan: async () => ({ allow: false, reason: "policy" }) };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(403);
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.settle).toBe(0);
  });

  it("a scanner that throws fails closed with 503 and no upstream call", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.scanner = {
      scan: async () => {
        throw new Error("scanner crashed");
      },
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(h.calls.upstream).toHaveLength(0);
  });

  it("a scanner that allows lets the request through", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.scanner = { scan: async () => ({ allow: true }) };
    expect((await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps)).status).toBe(200);
  });
});

describe("headers: credentials are never forwarded, cookies are never returned", () => {
  it("the upstream never receives PAYMENT-SIGNATURE, Cookie, Authorization, Host or hop-by-hop headers", async () => {
    const cfg = config();
    const h = harness(cfg);
    await handlePaidRequest(
      request(cfg, {
        ...paidHeaders(cfg),
        cookie: "session=1",
        authorization: "Bearer x",
        host: "proxy.example.test",
        connection: "keep-alive, x-private",
        "x-private": "secret",
        "keep-alive": "timeout=5",
        accept: "application/json",
      }),
      h.deps,
    );
    const forwarded = h.calls.upstream[0]!.headers;
    for (const forbidden of [
      "payment-signature",
      "cookie",
      "authorization",
      "host",
      "keep-alive",
      "x-private",
    ]) {
      expect(forwarded).not.toHaveProperty(forbidden);
    }
    expect(forwarded).toHaveProperty("accept", "application/json");
  });

  it.each([
    ["set-cookie", "a=b"],
    ["transfer-encoding", "chunked"],
    ["link", "<https://evil.test>; rel=preload"],
    ["content-location", "/elsewhere"],
    ["location", "https://elsewhere.test/"],
    ["server", "upstream/1.0"],
    ["via", "1.1 internal"],
    ["x-powered-by", "PHP/8"],
    ["access-control-allow-origin", "*"],
    ["etag", '"abc"'],
    ["last-modified", "Mon, 01 Jan 2024 00:00:00 GMT"],
    ["x-internal-trace", "trace-id"],
  ])("B6: the buyer never receives upstream header %s", async (name, value) => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = {
      status: 200,
      headers: { "content-type": "text/plain", [name]: value },
      body: new TextEncoder().encode("ok"),
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(Object.keys(response.headers).map((k) => k.toLowerCase())).not.toContain(name);
  });

  it("B6: the allowlisted headers pass through", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-language": "pt",
        "content-disposition": "inline",
        "x-request-id": "req-1",
      },
      body: new TextEncoder().encode("ok"),
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.headers).toMatchObject({
      "content-type": "text/plain",
      "content-language": "pt",
      "content-disposition": "inline",
      "x-request-id": "req-1",
    });
  });

  it("B6: a paid 2xx response is private, no-store and varies on the payment", async () => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["vary"]).toBe("payment-signature");
  });

  it("B6: a non-paid response carries no upstream cache headers", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = { kind: "refused", reason: "x" };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("B6: request and response sanitizers match the allowlist, not a denylist", () => {
    const guarded = runGuard({
      method: "GET",
      path: "/x",
      headers: { Cookie: "a", Connection: "x-a", "X-A": "1", Accept: "*/*" },
      body: new Uint8Array(),
      config: { allowedMethods: ["GET"], maxRequestBytes: 1024, allowedContentTypes: [] },
    });
    expect(guarded.ok && guarded.headers).toEqual({ accept: "*/*" });
    expect(
      sanitizeResponseHeaders({ "Set-Cookie": "a", "X-B": "2", "Content-Type": "x/y" }),
    ).toEqual({ "content-type": "x/y" });
  });
});

describe("I7: the flow reads only through its injected ports", () => {
  it("I7: the receipt and the forwarded request carry no seller or server secret", async () => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    const forwarded = JSON.stringify(h.calls.upstream);
    expect(forwarded).not.toMatch(/ANTHROPIC|BOOTSTRAP|KV_CONFIG_REST_API_TOKEN/);
    expect(Object.keys(response.headers).join(" ")).not.toMatch(/authorization|secret/i);
  });
});

describe("B3: the replay lock is keyed on the canonical payload and released when no upstream call happened", () => {
  const payloadA = { authorization: "opaque", nonce: 7 };

  function reEncoded(
    cfg: ProxyConfig,
    payload: Record<string, unknown>,
    outer: Record<string, unknown> = {},
  ): string {
    return encodeHeader({ ...outer, x402Version: 2, accepted: requirementsFor(cfg), payload });
  }

  it("B3: a verify that is invalid releases the lock, so a re-encoded retry is not answered 409", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.verifyOutcome = { kind: "invalid", reason: "bad_sig" };
    const first = await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, payloadA) }),
      h.deps,
    );
    expect(first.status).toBe(402);
    h.verifyOutcome = { kind: "valid" };
    const retry = await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, payloadA, { resource: { url: "x" } }) }),
      h.deps,
    );
    expect(retry.status).toBe(200);
    expect(h.calls.verify).toBe(2);
  });

  it("B3: an unavailable facilitator at verify releases the lock for a legitimate retry", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.verifyOutcome = { kind: "unavailable" };
    expect(
      (
        await handlePaidRequest(
          request(cfg, paidHeaders(cfg, { accepted: requirementsFor(cfg), payload: payloadA })),
          h.deps,
        )
      ).status,
    ).toBe(503);
    h.verifyOutcome = { kind: "valid" };
    expect(
      (
        await handlePaidRequest(
          request(cfg, paidHeaders(cfg, { accepted: requirementsFor(cfg), payload: payloadA })),
          h.deps,
        )
      ).status,
    ).toBe(200);
  });

  it("B3: a scanner block releases the lock for a legitimate retry", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.scanner = { scan: async () => ({ allow: false, reason: "policy" }) };
    expect(
      (
        await handlePaidRequest(
          request(cfg, { "payment-signature": reEncoded(cfg, payloadA) }),
          h.deps,
        )
      ).status,
    ).toBe(403);
    h.scanner = { scan: async () => ({ allow: true }) };
    expect(
      (
        await handlePaidRequest(
          request(cfg, { "payment-signature": reEncoded(cfg, payloadA) }),
          h.deps,
        )
      ).status,
    ).toBe(200);
  });

  it("B3: once the upstream has been called, the lock is kept and a re-encoded copy gets 409", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = { status: 500, headers: {}, body: new Uint8Array() };
    expect(
      (
        await handlePaidRequest(
          request(cfg, { "payment-signature": reEncoded(cfg, payloadA) }),
          h.deps,
        )
      ).status,
    ).toBe(502);
    h.upstreamResult = { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
    const copy = await handlePaidRequest(
      request(cfg, {
        "payment-signature": reEncoded(cfg, payloadA, { extensions: { note: "same payment" } }),
      }),
      h.deps,
    );
    expect(copy.status).toBe(409);
    expect(h.calls.upstream).toHaveLength(1);
  });

  it("B3: two payloads that differ in one value do not collide", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = { status: 500, headers: {}, body: new Uint8Array() };
    await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, payloadA) }),
      h.deps,
    );
    h.upstreamResult = { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
    const other = await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, { ...payloadA, nonce: 8 }) }),
      h.deps,
    );
    expect(other.status).toBe(200);
  });

  it("B3: payload key order does not change the lock key", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.upstreamResult = { status: 500, headers: {}, body: new Uint8Array() };
    await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, { a: 1, b: 2 }) }),
      h.deps,
    );
    h.upstreamResult = { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
    const reordered = await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, { b: 2, a: 1 }) }),
      h.deps,
    );
    expect(reordered.status).toBe(409);
  });

  it("B3: if the release itself fails, the lock stays and the request fails closed", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.verifyOutcome = { kind: "invalid", reason: "bad_sig" };
    const failingDeps = {
      ...h.deps,
      state: {
        setNx: async () => true,
        delete: async () => {
          throw new Error("KV unavailable");
        },
      },
    };
    const response = await handlePaidRequest(
      request(cfg, { "payment-signature": reEncoded(cfg, payloadA) }),
      failingDeps,
    );
    expect(response.status).toBe(402);
  });
});

describe("B1: the upstream URL is built from the seller's base path, never from the buyer's path", () => {
  it.each([
    ["/../admin"],
    ["/%2e%2e/admin"],
    ["/%252e%252e/admin"],
    ["//evil.test/x"],
    ["/a\\..\\b"],
  ])("a traversal path %s gets 400 before any payment or upstream call", async (path) => {
    const cfg = config();
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg), { path }), h.deps);
    expect(response.status).toBe(400);
    expect(h.calls.verify).toBe(0);
    expect(h.calls.upstream).toHaveLength(0);
  });

  it("the upstream receives the URL under the seller's base path", async () => {
    const cfg = config();
    const h = harness(cfg);
    await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(h.calls.upstream[0]?.url).toBe("https://api.example.com/v1/forecast?city=lisbon");
  });
});

describe("B2: an ambiguous settle is logged and never treated as nothing spent", () => {
  function loggedDeps(h: Harness) {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    return {
      events,
      deps: {
        ...h.deps,
        logger: {
          warn: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
        },
      } as FlowDeps,
    };
  }

  it("a settle that times out (no response) is logged as settle_ambiguous and never retried", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = {
      kind: "terminal_charged",
      transaction: null,
      reason: "ambiguous: no response",
    };
    const { deps, events } = loggedDeps(h);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
    expect(response.status).toBe(502);
    expect(h.calls.settle).toBe(1);
    expect(events.map((e) => e.event)).toEqual(["settle_ambiguous"]);
  });

  it("logs carry the proxy id and reason, never the signature or the target URL", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = {
      kind: "terminal_charged",
      transaction: null,
      reason: "ambiguous: no response",
    };
    const { deps, events } = loggedDeps(h);
    const signature = paidHeaders(cfg)["payment-signature"]!;
    await handlePaidRequest(request(cfg, { "payment-signature": signature }), deps);
    const text = JSON.stringify(events);
    expect(text).not.toContain(signature);
    expect(text).not.toContain("api.example.com");
    expect(events[0]?.fields).toEqual({
      proxy_id: "weather-api",
      reason: "ambiguous: no response",
    });
  });

  it("an unreadable settle that throws is logged as settle_unknown", async () => {
    const cfg = config();
    const h = harness(cfg);
    const { events, deps: loggedBase } = loggedDeps(h);
    const deps = {
      ...loggedBase,
      facilitator: {
        verify: async () => ({ kind: "valid" as const }),
        settle: async () => {
          throw new Error("socket hang up");
        },
      },
    };
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
    expect(response.status).toBe(502);
    expect(events.map((e) => e.event)).toEqual(["settle_unknown"]);
  });

  it("a clean retry_safe settle is not logged as ambiguous", async () => {
    const cfg = config();
    const h = harness(cfg);
    h.settleOutcome = { kind: "retry_safe", reason: "settle_exact_stellar_transaction_failed" };
    const { deps, events } = loggedDeps(h);
    await handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
    expect(events).toEqual([]);
  });
});

describe("I8: a guard failure never reaches the upstream and never triggers a settle", () => {
  it.each([
    ["a disallowed method", { method: "DELETE" }, {}, 405],
    ["a path over the length cap", { path: `/${"a".repeat(2048)}` }, {}, 414],
    ["a body over the byte cap", { method: "POST", body: new Uint8Array(65_537) }, {}, 413],
    [
      "a disallowed content type",
      { method: "POST", body: new TextEncoder().encode("<a/>") },
      { "content-type": "text/html" },
      415,
    ],
    [
      "invalid JSON under a JSON content type",
      { method: "POST", body: new TextEncoder().encode("{bad") },
      { "content-type": "application/json" },
      400,
    ],
    ["a NUL byte in the path", { path: "/a\u0000b" }, {}, 400],
  ])(
    "I8: %s gets a rejection with no verify, upstream or settle call",
    async (_n, over, headers, status) => {
      const cfg = config({ allowedMethods: ["GET", "POST"], sideEffectsAcknowledged: true });
      const h = harness(cfg);
      const response = await handlePaidRequest(
        request(cfg, { ...paidHeaders(cfg), ...headers }, over as Partial<ProxyRequest>),
        h.deps,
      );
      expect(response.status).toBe(status);
      expect(h.calls.verify).toBe(0);
      expect(h.calls.upstream).toHaveLength(0);
      expect(h.calls.settle).toBe(0);
    },
  );
});

describe("scanner timeout: a scanner that never answers blocks the request", () => {
  it(
    "returns 503 scanner_unavailable with no upstream call, and releases the lock",
    async () => {
      const cfg = config();
      const h = harness(cfg);
      h.scanner = { scan: () => new Promise<never>(() => undefined) };
      const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
      expect(response.status).toBe(503);
      expect(JSON.parse(bodyText(response)).error).toBe("scanner_unavailable");
      expect(h.calls.upstream).toHaveLength(0);
      expect(h.calls.settle).toBe(0);
      h.scanner = { scan: async () => ({ allow: true }) };
      expect((await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps)).status).toBe(200);
    },
    SCANNER_TIMEOUT_MS + 5_000,
  );
});

describe("B7: origin authentication is injected, merged last, and fails closed", () => {
  const SECRET = "origin-secret-value";
  const originCfg = (mode: "none" | "secret_header") =>
    config({ originAuth: { mode, headerName: "x-payr-origin-key" } });

  function withAuth(h: Harness, headersFor: () => Record<string, string> | Promise<never>) {
    return { ...h.deps, originAuth: { headersFor } } as FlowDeps;
  }

  it("mode none adds no origin header, even when an authenticator is injected", async () => {
    const cfg = originCfg("none");
    const h = harness(cfg);
    await handlePaidRequest(
      request(cfg, paidHeaders(cfg)),
      withAuth(h, () => ({ "x-payr-origin-key": SECRET })),
    );
    expect(h.calls.upstream[0]!.headers).not.toHaveProperty("x-payr-origin-key");
  });

  it("mode secret_header sends the authenticator's header to the upstream", async () => {
    const cfg = originCfg("secret_header");
    const h = harness(cfg);
    const response = await handlePaidRequest(
      request(cfg, paidHeaders(cfg)),
      withAuth(h, () => ({ "x-payr-origin-key": SECRET })),
    );
    expect(response.status).toBe(200);
    expect(h.calls.upstream[0]!.headers).toHaveProperty("x-payr-origin-key", SECRET);
  });

  it("the buyer's header with the same name never reaches the upstream; the authenticator's value wins", async () => {
    const cfg = originCfg("secret_header");
    const h = harness(cfg);
    await handlePaidRequest(
      request(cfg, { ...paidHeaders(cfg), "x-payr-origin-key": "attacker" }),
      withAuth(h, () => ({ "x-payr-origin-key": SECRET })),
    );
    expect(h.calls.upstream[0]!.headers["x-payr-origin-key"]).toBe(SECRET);
  });

  it("the authenticator cannot add other headers: only the configured name is merged", async () => {
    const cfg = originCfg("secret_header");
    const h = harness(cfg);
    await handlePaidRequest(
      request(cfg, paidHeaders(cfg)),
      withAuth(h, () => ({ "x-payr-origin-key": SECRET, cookie: "smuggled=1" })),
    );
    expect(h.calls.upstream[0]!.headers).not.toHaveProperty("cookie");
  });

  it("secret_header with no authenticator injected gets 503 and no upstream call", async () => {
    const cfg = originCfg("secret_header");
    const h = harness(cfg);
    const response = await handlePaidRequest(request(cfg, paidHeaders(cfg)), h.deps);
    expect(response.status).toBe(503);
    expect(JSON.parse(bodyText(response)).error).toBe("origin_auth_unavailable");
    expect(h.calls.upstream).toHaveLength(0);
    expect(h.calls.settle).toBe(0);
  });

  it("headersFor that throws gets 503 with no upstream call, and the replay lock is released", async () => {
    const cfg = originCfg("secret_header");
    const h = harness(cfg);
    const failing = withAuth(h, () => Promise.reject(new Error("vault down")));
    const first = await handlePaidRequest(request(cfg, paidHeaders(cfg)), failing);
    expect(first.status).toBe(503);
    expect(h.calls.upstream).toHaveLength(0);
    const retry = await handlePaidRequest(
      request(cfg, paidHeaders(cfg)),
      withAuth(h, () => ({ "x-payr-origin-key": SECRET })),
    );
    expect(retry.status).toBe(200);
  });

  it("headersFor that returns no value for the configured name gets 503 and no upstream call", async () => {
    const cfg = originCfg("secret_header");
    const h = harness(cfg);
    const response = await handlePaidRequest(
      request(cfg, paidHeaders(cfg)),
      withAuth(h, () => ({ "x-other": "1" })),
    );
    expect(response.status).toBe(503);
    expect(h.calls.upstream).toHaveLength(0);
  });
});

describe("B8: the target host never reaches the buyer or the logs", () => {
  const TARGET_HOST = "api.example.com";

  function timeoutError(): Error {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    return error;
  }

  const outcomes: Array<{
    name: string;
    run: (cfg: ProxyConfig, h: Harness, deps: FlowDeps) => Promise<ProxyResponse>;
  }> = [
    { name: "unpaid", run: (cfg, _h, deps) => handlePaidRequest(request(cfg), deps) },
    {
      name: "bad method",
      run: (cfg, _h, deps) => handlePaidRequest(request(cfg, {}, { method: "PUT" }), deps),
    },
    {
      name: "traversal",
      run: (cfg, _h, deps) =>
        handlePaidRequest(request(cfg, paidHeaders(cfg), { path: "/../x" }), deps),
    },
    {
      name: "invalid verify",
      run: (cfg, h, deps) => {
        h.verifyOutcome = { kind: "invalid", reason: "bad_sig" };
        return handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
      },
    },
    {
      name: "upstream 500",
      run: (cfg, h, deps) => {
        h.upstreamResult = { status: 500, headers: {}, body: new Uint8Array() };
        return handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
      },
    },
    {
      name: "upstream timeout",
      run: (cfg, h, deps) => {
        h.upstreamResult = timeoutError();
        return handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
      },
    },
    {
      name: "settled",
      run: (cfg, _h, deps) => handlePaidRequest(request(cfg, paidHeaders(cfg)), deps),
    },
    {
      name: "terminal charged",
      run: (cfg, h, deps) => {
        h.settleOutcome = { kind: "terminal_charged", transaction: null, reason: "ambiguous: x" };
        return handlePaidRequest(request(cfg, paidHeaders(cfg)), deps);
      },
    },
    {
      name: "settle throws",
      run: (cfg, _h, deps) =>
        handlePaidRequest(request(cfg, paidHeaders(cfg)), {
          ...deps,
          facilitator: {
            verify: async () => ({ kind: "valid" as const }),
            settle: async () => {
              throw new Error("socket hang up");
            },
          },
        }),
    },
  ];

  it.each(outcomes.map((o) => [o.name, o] as const))(
    "%s: neither the response nor the logs contain the target host",
    async (_name, outcome) => {
      const cfg = config();
      const h = harness(cfg);
      const events: { event: string; fields: Record<string, unknown> }[] = [];
      const deps = {
        ...h.deps,
        logger: {
          warn: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
        },
      } as FlowDeps;
      const response = await outcome.run(cfg, h, deps);
      const surface = JSON.stringify({
        status: response.status,
        headers: response.headers,
        body: decoder.decode(response.body),
      });
      expect(surface).not.toContain(TARGET_HOST);
      expect(JSON.stringify(events)).not.toContain(TARGET_HOST);
    },
  );
});
