import { describe, expect, it } from "vitest";

import { EnvValidationError, publicSchema, type RawEnv } from "@/env.proxy";
import { parseServerEnv, serverSchema } from "@/env.server";

const valid: RawEnv = {
  VELLAR_FACILITATOR_URL: "https://facilitator.example.test",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  KV_CONFIG_REST_API_URL: "https://config.kv.example.test",
  KV_CONFIG_READ_ONLY_TOKEN: "test-config-read-token",
  KV_CONFIG_REST_API_TOKEN: "test-config-write-token",
  KV_STATE_REST_API_URL: "https://state.kv.example.test",
  KV_STATE_REST_API_TOKEN: "test-state-token",
  VELLAR_BOOTSTRAP_AGENT_KEY: "test-bootstrap-key",
  ANTHROPIC_MODEL: "test-model-id",
  NEXT_PUBLIC_VELLAR_NETWORK: "testnet",
};

function problemsFor(raw: RawEnv): string[] {
  try {
    parseServerEnv(raw);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return [...error.problems];
    }
    throw error;
  }
  return [];
}

describe("parseServerEnv", () => {
  it("accepts a complete, valid environment", () => {
    const env = parseServerEnv(valid);
    expect(env.NEXT_PUBLIC_VELLAR_NETWORK).toBe("testnet");
    expect(env.ANTHROPIC_MODEL).toBe("test-model-id");
  });

  it("fails fast and names the missing variable", () => {
    const raw: RawEnv = { ...valid, KV_CONFIG_REST_API_TOKEN: undefined };
    expect(() => parseServerEnv(raw)).toThrow(EnvValidationError);
    expect(problemsFor(raw)).toEqual(["KV_CONFIG_REST_API_TOKEN is missing"]);
  });

  it("treats an empty string as missing", () => {
    expect(problemsFor({ ...valid, ANTHROPIC_MODEL: "" })).toEqual(["ANTHROPIC_MODEL is missing"]);
  });

  it("reports every missing variable at once", () => {
    const problems = problemsFor({ NEXT_PUBLIC_VELLAR_NETWORK: "testnet" });
    for (const key of Object.keys(serverSchema.shape)) {
      if (key !== "NEXT_PUBLIC_VELLAR_NETWORK") {
        expect(problems).toContain(`${key} is missing`);
      }
    }
  });

  it("rejects a malformed URL and says which variable is wrong", () => {
    const problems = problemsFor({ ...valid, VELLAR_FACILITATOR_URL: "not a url" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^VELLAR_FACILITATOR_URL /);
  });

  it("rejects a network value outside testnet|mainnet", () => {
    const problems = problemsFor({ ...valid, NEXT_PUBLIC_VELLAR_NETWORK: "devnet" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^NEXT_PUBLIC_VELLAR_NETWORK /);
  });

  it("never echoes a secret value in the error message", () => {
    const secret = "sk-live-do-not-print-0123456789";
    try {
      parseServerEnv({ ...valid, KV_CONFIG_REST_API_URL: secret });
      expect.fail("expected validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("secret handling", () => {
  it("keeps every server variable free of the NEXT_PUBLIC_ prefix", () => {
    for (const key of Object.keys(serverSchema.shape)) {
      if (key !== "NEXT_PUBLIC_VELLAR_NETWORK") {
        expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
      }
    }
  });

  it("exposes only the network as a public variable", () => {
    expect(Object.keys(publicSchema.shape)).toEqual(["NEXT_PUBLIC_VELLAR_NETWORK"]);
  });
});
