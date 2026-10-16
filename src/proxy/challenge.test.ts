import { describe, expect, it } from "vitest";

import { parseProxyConfig, type ProxyConfig } from "@/proxy/config";
import {
  buildPaymentRequired,
  CHALLENGE_MAX_TIMEOUT_SECONDS,
  encodeHeader,
  parsePaymentSignature,
  PAYMENT_SIGNATURE_MAX_BYTES,
  requirementsFor,
  X402_VERSION,
} from "@/proxy/challenge";

function config(): ProxyConfig {
  const result = parseProxyConfig({
    version: 1,
    id: "weather-api",
    status: "active",
    targetUrl: "https://api.example.com/v1",
    priceBaseUnits: "500000",
    asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    payTo: "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
    network: "stellar:testnet",
    description: "Hourly forecast, per call",
  });
  if (!result.ok) {
    throw new Error(`test config invalid: ${result.issues.join("; ")}`);
  }
  return result.config;
}

function validSignature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: X402_VERSION,
    accepted: requirementsFor(config()),
    payload: { authorization: "opaque-signed-entry" },
    ...overrides,
  };
}

describe("buildPaymentRequired", () => {
  it("builds an exact-scheme challenge with the seller's terms", () => {
    const challenge = buildPaymentRequired(
      config(),
      "https://proxy.example.test/proxy/weather-api/forecast",
    );
    expect(challenge.x402Version).toBe(2);
    expect(challenge.resource.url).toBe("https://proxy.example.test/proxy/weather-api/forecast");
    expect(challenge.resource.description).toBe("Hourly forecast, per call");
    expect(challenge.accepts).toEqual([
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "500000",
        asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        payTo: "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
        maxTimeoutSeconds: CHALLENGE_MAX_TIMEOUT_SECONDS,
        extra: { areFeesSponsored: true },
      },
    ]);
  });

  it("includes an error code only when one is given", () => {
    expect(buildPaymentRequired(config(), "https://p.test/x")).not.toHaveProperty("error");
    expect(buildPaymentRequired(config(), "https://p.test/x", "payment_required")).toHaveProperty(
      "error",
      "payment_required",
    );
  });
});

describe("encodeHeader", () => {
  it("encodes JSON as base64 that round-trips", () => {
    const value = { a: 1, b: "two" };
    const encoded = encodeHeader(value);
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(value);
  });
});

describe("parsePaymentSignature", () => {
  it("accepts a well-formed envelope and keeps the payload opaque", () => {
    const header = encodeHeader(validSignature());
    const result = parsePaymentSignature(header);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signature.payload).toEqual({ authorization: "opaque-signed-entry" });
    }
  });

  it("rejects a header over 16 KiB before decoding it", () => {
    const oversized = "A".repeat(PAYMENT_SIGNATURE_MAX_BYTES + 1);
    expect(parsePaymentSignature(oversized)).toEqual({ ok: false, reason: "too-large" });
  });

  it("accepts a header exactly at the 16 KiB limit when it is valid", () => {
    const padding = "x".repeat(PAYMENT_SIGNATURE_MAX_BYTES);
    const header = encodeHeader(validSignature({ payload: { padding } }));
    expect(Buffer.byteLength(header)).toBeGreaterThan(PAYMENT_SIGNATURE_MAX_BYTES);
    expect(parsePaymentSignature(header)).toEqual({ ok: false, reason: "too-large" });
  });

  it.each([
    ["empty string", ""],
    ["non-base64 characters", "not base64!"],
    ["base64url alphabet", "abc-_def"],
    ["embedded whitespace", "eyJh bmM="],
  ])("rejects %s as malformed base64", (_name, header) => {
    expect(parsePaymentSignature(header)).toEqual({ ok: false, reason: "malformed-base64" });
  });

  it("rejects base64 that is not JSON", () => {
    expect(parsePaymentSignature(Buffer.from("not json", "utf8").toString("base64"))).toEqual({
      ok: false,
      reason: "malformed-json",
    });
  });

  it.each([
    ["wrong x402 version", validSignature({ x402Version: 1 })],
    ["missing accepted terms", { x402Version: 2, payload: {} }],
    ["payload is not an object", validSignature({ payload: "string" })],
    [
      "accepted amount is not a string",
      validSignature({ accepted: { ...requirementsFor(config()), amount: 5 } }),
    ],
  ])("rejects an envelope with %s", (_name, body) => {
    expect(parsePaymentSignature(encodeHeader(body))).toEqual({
      ok: false,
      reason: "malformed-envelope",
    });
  });
});
