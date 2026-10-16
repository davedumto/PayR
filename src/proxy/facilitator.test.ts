import { describe, expect, it } from "vitest";

import {
  classifySettle,
  classifyVerify,
  FACILITATOR_BODY_MAX_BYTES,
  FacilitatorClient,
  type FacilitatorFetch,
  readCapped,
  type SettleObservation,
} from "@/proxy/facilitator";

const BASE = "https://facilitator.example.test";

// Cases follow the Vellar error table (reference/error-codes) and the settle
// outcome rules (architecture/settlement-path). Each row is one observed response.
const SETTLE_CASES: readonly (readonly [string, SettleObservation, string])[] = [
  [
    "200 with a transaction hash is settled",
    { status: 200, body: { success: true, transaction: "abc123" } },
    "settled",
  ],
  [
    "402 with an empty transaction and a submission failure is retry_safe",
    {
      status: 402,
      body: {
        success: false,
        transaction: "",
        errorReason: "settle_exact_stellar_transaction_submission_failed",
      },
    },
    "retry_safe",
  ],
  [
    "402 with an empty transaction and a transaction failure is retry_safe",
    {
      status: 402,
      body: {
        success: false,
        transaction: "",
        errorReason: "settle_exact_stellar_transaction_failed",
      },
    },
    "retry_safe",
  ],
  [
    "402 with an empty transaction and no reason is retry_safe",
    { status: 402, body: { success: false, transaction: "" } },
    "retry_safe",
  ],
  [
    "402 with a transaction hash is terminal_charged",
    {
      status: 402,
      body: {
        success: false,
        transaction: "deadbeef",
        errorReason: "settle_exact_stellar_transaction_failed",
      },
    },
    "terminal_charged",
  ],
  [
    "503 settlement_refused sponsor_balance_low is refused",
    { status: 503, body: { error: "settlement_refused", reason: "sponsor_balance_low" } },
    "refused",
  ],
  [
    "503 settlement_refused spend_ceiling is refused",
    { status: 503, body: { error: "settlement_refused", reason: "spend_ceiling" } },
    "refused",
  ],
  [
    "503 settlement_refused rate_limited_payto is refused",
    { status: 503, body: { error: "settlement_refused", reason: "rate_limited_payto" } },
    "refused",
  ],
  [
    "503 settlement_refused with an unknown reason is refused, not retried",
    { status: 503, body: { error: "settlement_refused", reason: "a_future_reason" } },
    "refused",
  ],
  ["503 service_paused is paused", { status: 503, body: { error: "service_paused" } }, "paused"],
  [
    "400 invalid_payload is invalid",
    { status: 400, body: { error: "invalid_payload" } },
    "invalid",
  ],
  [
    "402 fee_exceeds_maximum with an empty transaction is refused",
    { status: 402, body: { success: false, transaction: "", errorReason: "fee_exceeds_maximum" } },
    "refused",
  ],
  [
    "402 replayed authorization is invalid (buyer must re-sign)",
    {
      status: 402,
      body: {
        success: false,
        transaction: "",
        errorReason: "invalid_exact_stellar_payload_authorization_replayed",
      },
    },
    "invalid",
  ],
  [
    "402 missing trustline on the recipient is invalid",
    {
      status: 402,
      body: {
        success: false,
        transaction: "",
        errorReason: "invalid_exact_stellar_payload_missing_trustline_recipient",
      },
    },
    "invalid",
  ],
  [
    "200 success with an empty transaction is ambiguous, so terminal",
    { status: 200, body: { success: true, transaction: "" } },
    "terminal_charged",
  ],
  ["200 with no fields is ambiguous, so terminal", { status: 200, body: {} }, "terminal_charged"],
  [
    "500 with a plain-text body is ambiguous, so terminal",
    { status: 500, body: "internal error" },
    "terminal_charged",
  ],
  ["no response at all is ambiguous, so terminal", { unreachable: true }, "terminal_charged"],
];

describe("classifySettle (one outcome per observed response)", () => {
  it.each(SETTLE_CASES)("%s", (_name, observation, expected) => {
    expect(classifySettle(observation).kind).toBe(expected);
  });

  it("returns the transaction hash for a settled outcome", () => {
    expect(classifySettle({ status: 200, body: { success: true, transaction: "abc123" } })).toEqual(
      {
        kind: "settled",
        transaction: "abc123",
      },
    );
  });

  it("surfaces the hash for a terminal charge", () => {
    expect(
      classifySettle({
        status: 402,
        body: { success: false, transaction: "deadbeef", errorReason: "x" },
      }),
    ).toEqual({ kind: "terminal_charged", transaction: "deadbeef", reason: "x" });
  });

  it("never reports retry_safe when the transaction field is non-empty", () => {
    const outcome = classifySettle({
      status: 402,
      body: { success: false, transaction: "h", errorReason: "x" },
    });
    expect(outcome.kind).not.toBe("retry_safe");
  });
});

describe("classifyVerify", () => {
  const VERIFY_CASES: readonly (readonly [string, SettleObservation, string])[] = [
    ["isValid true is valid", { status: 200, body: { isValid: true } }, "valid"],
    [
      "isValid false is invalid",
      { status: 200, body: { isValid: false, invalidReason: "bad_sig" } },
      "invalid",
    ],
    ["503 service_paused is paused", { status: 503, body: { error: "service_paused" } }, "paused"],
    ["500 is unavailable", { status: 500, body: "oops" }, "unavailable"],
    ["a body with no isValid is unavailable", { status: 200, body: { ok: true } }, "unavailable"],
    ["no response is unavailable", { unreachable: true }, "unavailable"],
  ];

  it.each(VERIFY_CASES)("%s", (_name, observation, expected) => {
    expect(classifyVerify(observation).kind).toBe(expected);
  });

  it("keeps the invalid reason from the facilitator", () => {
    expect(
      classifyVerify({ status: 200, body: { isValid: false, invalidReason: "bad_sig" } }),
    ).toEqual({
      kind: "invalid",
      reason: "bad_sig",
    });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FacilitatorClient", () => {
  it("refuses a plain http base URL outside localhost", () => {
    expect(
      () =>
        new FacilitatorClient({
          baseUrl: "http://facilitator.example.test",
          verifyTimeoutMs: 1000,
          settleTimeoutMs: 1000,
        }),
    ).toThrow(TypeError);
  });

  it("posts to /verify with no redirects and a timeout signal", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FacilitatorFetch = async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(200, { isValid: true, payer: "GPAYER" });
    };
    const client = new FacilitatorClient({
      baseUrl: `${BASE}/`,
      verifyTimeoutMs: 1000,
      settleTimeoutMs: 1000,
      fetch: fetchImpl,
    });
    expect(await client.verify({ x402Version: 2 })).toEqual({ kind: "valid", payer: "GPAYER" });
    expect(seen[0]?.url).toBe(`${BASE}/verify`);
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(seen[0]?.init.signal).toBeDefined();
  });

  it("treats a redirect as unreachable for settle, so it is terminal", async () => {
    const client = new FacilitatorClient({
      baseUrl: BASE,
      verifyTimeoutMs: 1000,
      settleTimeoutMs: 1000,
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    });
    expect((await client.settle({})).kind).toBe("terminal_charged");
  });

  it("treats a network failure during verify as unavailable (fail closed)", async () => {
    const client = new FacilitatorClient({
      baseUrl: BASE,
      verifyTimeoutMs: 1000,
      settleTimeoutMs: 1000,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await client.verify({})).toEqual({ kind: "unavailable" });
  });

  it("treats a timeout during settle as ambiguous, so terminal", async () => {
    const client = new FacilitatorClient({
      baseUrl: BASE,
      verifyTimeoutMs: 1000,
      settleTimeoutMs: 1,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    expect((await client.settle({})).kind).toBe("terminal_charged");
  });

  it("treats a body over 32 KiB as unreachable, so verify is unavailable", async () => {
    const big = "x".repeat(FACILITATOR_BODY_MAX_BYTES + 1);
    const client = new FacilitatorClient({
      baseUrl: BASE,
      verifyTimeoutMs: 1000,
      settleTimeoutMs: 1000,
      fetch: async () => new Response(big, { status: 200 }),
    });
    expect(await client.verify({})).toEqual({ kind: "unavailable" });
  });
});

describe("readCapped", () => {
  it("returns the full body when it is within the cap", async () => {
    expect(await readCapped(new Response("hello"), 10)).toBe("hello");
  });

  it("returns undefined when the body exceeds the cap", async () => {
    expect(await readCapped(new Response("hello world"), 5)).toBeUndefined();
  });

  it("returns an empty string for a response with no body", async () => {
    expect(await readCapped(new Response(null), 5)).toBe("");
  });
});

describe("B2: each call uses its own timeout", () => {
  it("verify times out on verifyTimeoutMs and leaves settle alone", async () => {
    const client = new FacilitatorClient({
      baseUrl: BASE,
      verifyTimeoutMs: 5,
      settleTimeoutMs: 60_000,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "TimeoutError")),
          );
        }),
    });
    expect(await client.verify({})).toEqual({ kind: "unavailable" });
  });
});
