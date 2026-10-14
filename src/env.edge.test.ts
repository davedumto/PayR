import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EnvValidationError, getPublicNetwork, parseEdgeEnv, type RawEnv } from "@/env.edge";

const SERVER_ONLY = ["ANTHROPIC_API_KEY", "VELLAR_BOOTSTRAP_AGENT_KEY"] as const;

const valid: RawEnv = {
  VELLAR_FACILITATOR_URL: "https://facilitator.example.test",
  KV_REST_API_URL: "https://kv.example.test",
  KV_REST_API_TOKEN: "test-kv-token",
  NEXT_PUBLIC_VELLAR_NETWORK: "testnet",
};

function problemsFor(raw: RawEnv): string[] {
  try {
    parseEdgeEnv(raw);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return [...error.problems];
    }
    throw error;
  }
  return [];
}

describe("env.edge source boundary", () => {
  const source = readFileSync(new URL("./env.edge.ts", import.meta.url), "utf8");

  it.each(SERVER_ONLY)("never references the server-only secret %s", (name) => {
    expect(source).not.toContain(name);
  });

  it("does not import the server module or server-only", () => {
    expect(source).not.toMatch(/from\s+["'][^"']*env\.server["']/);
    expect(source).not.toMatch(/["']server-only["']/);
  });
});

describe("parseEdgeEnv", () => {
  it("accepts the Edge variables", () => {
    expect(parseEdgeEnv(valid).NEXT_PUBLIC_VELLAR_NETWORK).toBe("testnet");
  });

  it("names a missing Edge variable", () => {
    expect(problemsFor({ ...valid, KV_REST_API_TOKEN: undefined })).toEqual([
      "KV_REST_API_TOKEN is missing",
    ]);
  });

  it("rejects a malformed facilitator URL", () => {
    const problems = problemsFor({ ...valid, VELLAR_FACILITATOR_URL: "not a url" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^VELLAR_FACILITATOR_URL /);
  });

  it("does not require server secrets", () => {
    // The Edge set must validate with no server-only variables present at all.
    expect(() => parseEdgeEnv(valid)).not.toThrow();
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
