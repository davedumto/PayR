import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EnvValidationError, getPublicNetwork, parseProxyEnv, type RawEnv } from "@/env.proxy";

const SERVER_ONLY = [
  "ANTHROPIC_API_KEY",
  "VELLAR_BOOTSTRAP_AGENT_KEY",
  "KV_CONFIG_REST_API_TOKEN",
] as const;

const valid: RawEnv = {
  VELLAR_FACILITATOR_URL: "https://facilitator.example.test",
  KV_CONFIG_REST_API_URL: "https://config.kv.example.test",
  KV_CONFIG_READ_ONLY_TOKEN: "test-config-read-token",
  KV_STATE_REST_API_URL: "https://state.kv.example.test",
  KV_STATE_REST_API_TOKEN: "test-state-token",
  NEXT_PUBLIC_VELLAR_NETWORK: "testnet",
};

function problemsFor(raw: RawEnv): string[] {
  try {
    parseProxyEnv(raw);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return [...error.problems];
    }
    throw error;
  }
  return [];
}

describe("env.proxy source boundary", () => {
  const source = readFileSync(new URL("./env.proxy.ts", import.meta.url), "utf8");

  it.each(SERVER_ONLY)("never references the server-only secret %s", (name) => {
    expect(source).not.toContain(name);
  });

  it("does not import the server module or server-only", () => {
    expect(source).not.toMatch(/from\s+["'][^"']*env\.server["']/);
    expect(source).not.toMatch(/["']server-only["']/);
  });
});

describe("parseProxyEnv", () => {
  it("accepts the proxy variables", () => {
    expect(parseProxyEnv(valid).NEXT_PUBLIC_VELLAR_NETWORK).toBe("testnet");
  });

  it("names a missing proxy variable", () => {
    expect(problemsFor({ ...valid, KV_STATE_REST_API_TOKEN: undefined })).toEqual([
      "KV_STATE_REST_API_TOKEN is missing",
    ]);
  });

  it("requires a read-only token for the config store", () => {
    expect(problemsFor({ ...valid, KV_CONFIG_READ_ONLY_TOKEN: undefined })).toEqual([
      "KV_CONFIG_READ_ONLY_TOKEN is missing",
    ]);
  });

  it("rejects a malformed facilitator URL", () => {
    const problems = problemsFor({ ...valid, VELLAR_FACILITATOR_URL: "not a url" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^VELLAR_FACILITATOR_URL /);
  });

  it("rejects plain http for the facilitator outside localhost", () => {
    const problems = problemsFor({
      ...valid,
      VELLAR_FACILITATOR_URL: "http://facilitator.example.test",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^VELLAR_FACILITATOR_URL must be an absolute https URL/);
  });

  it("allows http to localhost in tests", () => {
    expect(() =>
      parseProxyEnv({ ...valid, VELLAR_FACILITATOR_URL: "http://localhost:4010" }),
    ).not.toThrow();
  });

  it.each(["KV_CONFIG_REST_API_URL", "KV_STATE_REST_API_URL"] as const)(
    "rejects plain http for %s",
    (key) => {
      const problems = problemsFor({ ...valid, [key]: "http://kv.example.test" });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith(`${key} must be an absolute https URL`)).toBe(true);
    },
  );

  it("does not require server secrets", () => {
    expect(() => parseProxyEnv(valid)).not.toThrow();
  });
});

describe("getPublicNetwork", () => {
  it("reads only the public network and ignores every other variable", () => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (key !== "NEXT_PUBLIC_VELLAR_NETWORK") {
          delete process.env[key];
        }
      }
      process.env.NEXT_PUBLIC_VELLAR_NETWORK = "mainnet";
      expect(getPublicNetwork()).toBe("mainnet");
    } finally {
      process.env = saved;
    }
  });

  it("rejects an unknown network value", () => {
    const saved = process.env.NEXT_PUBLIC_VELLAR_NETWORK;
    try {
      process.env.NEXT_PUBLIC_VELLAR_NETWORK = "devnet";
      expect(() => getPublicNetwork()).toThrow(EnvValidationError);
    } finally {
      process.env.NEXT_PUBLIC_VELLAR_NETWORK = saved;
    }
  });
});
