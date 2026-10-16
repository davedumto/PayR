import { describe, expect, it } from "vitest";

import {
  MAX_PRICE_BASE_UNITS,
  parseDecimalToBaseUnits,
  parseProxyConfig,
  ProxyConfigSchema,
  worstCaseBudgetMs,
} from "@/proxy/config";

// Stellar test vectors from @stellar/stellar-base (see strkey.test.ts).
const PAY_TO = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const SECRET_SEED = "SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X";

const validInput = {
  version: 1,
  id: "weather-api",
  status: "active",
  targetUrl: "https://api.example.com/v1/forecast",
  priceBaseUnits: "500000",
  asset: CONTRACT,
  payTo: PAY_TO,
  network: "stellar:testnet",
  description: "Hourly forecast, per call",
};

function issuesFor(overrides: Record<string, unknown>): string[] {
  const result = parseProxyConfig({ ...validInput, ...overrides });
  return result.ok ? [] : [...result.issues];
}

describe("ProxyConfigSchema", () => {
  it("accepts a valid config and fills the documented defaults", () => {
    const result = parseProxyConfig(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.allowedMethods).toEqual(["GET", "POST"]);
      expect(result.config.maxRequestBytes).toBe(65_536);
      expect(result.config.maxResponseBytes).toBe(1_048_576);
      expect(result.config.upstreamTimeoutMs).toBe(10_000);
      expect(result.config.verifyTimeoutMs).toBe(5_000);
      expect(result.config.settleTimeoutMs).toBe(45_000);
    }
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(issuesFor({ isAdmin: true }).join(" ")).toMatch(/unrecognized/i);
  });

  it.each([
    ["uppercase id", "Weather-API"],
    ["id shorter than 3 characters", "ab"],
    ["id starting with a hyphen", "-weather"],
    ["id longer than 63 characters", "a".repeat(64)],
    ["id with an underscore", "weather_api"],
  ])("rejects %s", (_name, id) => {
    expect(issuesFor({ id }).join(" ")).toMatch(/^id:/m);
  });

  it.each([
    ["zero", "0"],
    ["leading zero", "05"],
    ["negative", "-1"],
    ["decimal point", "1.5"],
    ["exponent", "1e3"],
    ["plus sign", "+1"],
    ["empty", ""],
    ["whitespace", " 1"],
    ["above the maximum", (MAX_PRICE_BASE_UNITS + 1n).toString()],
  ])("rejects a price that is %s", (_name, priceBaseUnits) => {
    expect(issuesFor({ priceBaseUnits }).join(" ")).toMatch(/priceBaseUnits/);
  });

  it("accepts the maximum price exactly", () => {
    expect(issuesFor({ priceBaseUnits: MAX_PRICE_BASE_UNITS.toString() })).toEqual([]);
  });

  it("requires the asset to be a contract (C) address", () => {
    expect(issuesFor({ asset: PAY_TO }).join(" ")).toMatch(
      /asset: must be a valid Stellar contract/,
    );
  });

  it("rejects a payTo that is a secret seed", () => {
    expect(issuesFor({ payTo: SECRET_SEED }).join(" ")).toMatch(/payTo/);
  });

  it("rejects a payTo with a bad checksum", () => {
    expect(issuesFor({ payTo: `${PAY_TO.slice(0, 55)}A` }).join(" ")).toMatch(/payTo/);
  });

  it("rejects a target URL that the static SSRF check refuses", () => {
    expect(issuesFor({ targetUrl: "https://169.254.169.254/latest" }).join(" ")).toMatch(
      /targetUrl: target URL rejected: non-public-ip/,
    );
  });

  it("rejects a plain http target", () => {
    expect(issuesFor({ targetUrl: "http://api.example.com/" }).join(" ")).toMatch(/scheme/);
  });

  it("rejects a network outside the two supported identifiers", () => {
    expect(issuesFor({ network: "stellar:futurenet" }).join(" ")).toMatch(/network/);
  });

  it.each([
    ["a newline", "line one\nline two"],
    ["non-ASCII text", "Préci­sion"],
    ["an empty string", ""],
    ["more than 256 characters", "x".repeat(257)],
  ])("rejects a description with %s", (_name, description) => {
    expect(issuesFor({ description }).join(" ")).toMatch(/description/);
  });

  it("accepts a description of exactly 256 printable characters", () => {
    expect(issuesFor({ description: "x".repeat(256) })).toEqual([]);
  });

  it("rejects an unknown method", () => {
    expect(issuesFor({ allowedMethods: ["TRACE"] }).join(" ")).toMatch(/allowedMethods/);
  });

  it("rejects request and response limits outside their bounds", () => {
    expect(issuesFor({ maxRequestBytes: 2_000_000 }).join(" ")).toMatch(/maxRequestBytes/);
    expect(issuesFor({ maxResponseBytes: 0 }).join(" ")).toMatch(/maxResponseBytes/);
  });

  it("rejects a status other than active or paused", () => {
    expect(issuesFor({ status: "deleted" }).join(" ")).toMatch(/status/);
  });

  it("reports the schema type, not an input value, for a non-object", () => {
    expect(parseProxyConfig("not an object").ok).toBe(false);
  });

  it("is strict on the output type too", () => {
    expect(ProxyConfigSchema.safeParse({ ...validInput, extra: 1 }).success).toBe(false);
  });
});

describe("parseDecimalToBaseUnits", () => {
  it.each([
    ["1", 10_000_000n],
    ["0", 0n],
    ["0.5", 5_000_000n],
    ["0.0000001", 1n],
    ["1.0000000", 10_000_000n],
    ["12.3456789", 123_456_789n],
    ["100", 1_000_000_000n],
  ])("converts %s to %s base units", (input, expected) => {
    expect(parseDecimalToBaseUnits(input)).toBe(expected);
  });

  it.each([
    ["more than seven decimals", "1.00000001"],
    ["a negative sign", "-1"],
    ["a plus sign", "+1"],
    ["an exponent", "1e3"],
    ["an upper-case exponent", "1E3"],
    ["a leading decimal point", ".5"],
    ["a trailing decimal point", "1."],
    ["a thousands separator", "1,000"],
    ["two decimal points", "1.2.3"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["a leading zero", "01"],
    ["a hex literal", "0x10"],
    ["whitespace", " 1 "],
    ["an empty string", ""],
  ])("rejects %s", (_name, input) => {
    expect(() => parseDecimalToBaseUnits(input)).toThrow(RangeError);
  });

  it("rejects a JavaScript number, which may already be a float", () => {
    expect(() => parseDecimalToBaseUnits(1.5)).toThrow(TypeError);
    expect(() => parseDecimalToBaseUnits(1)).toThrow(TypeError);
  });
});

describe("B2: split timeouts and the request budget", () => {
  it("rejects the old single facilitatorTimeoutMs key", () => {
    expect(issuesFor({ facilitatorTimeoutMs: 5000 }).join(" ")).toMatch(/unrecognized/i);
  });

  it("caps settle at 60 s and verify at 15 s", () => {
    expect(issuesFor({ settleTimeoutMs: 60_001 }).join(" ")).toMatch(/settleTimeoutMs/);
    expect(issuesFor({ settleTimeoutMs: 60_000 })).toEqual([]);
    expect(issuesFor({ verifyTimeoutMs: 15_001 }).join(" ")).toMatch(/verifyTimeoutMs/);
  });

  it("defaults settle to 45 s, so the facilitator's own retries fit", () => {
    const result = parseProxyConfig(validInput);
    expect(result.ok && result.config.settleTimeoutMs).toBe(45_000);
  });

  it("worst-case budget fits inside the 120 s function duration in ADR 0001", () => {
    expect(worstCaseBudgetMs()).toBe(105_000);
    expect(worstCaseBudgetMs()).toBeLessThanOrEqual(120_000);
  });
});
