import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// I7: no proxy module may hold a key that can move funds or import the server env.
// This test reads the source of every non-test module in src/proxy.
const PROXY_DIR = new URL(".", import.meta.url).pathname;
const SERVER_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "VELLAR_BOOTSTRAP_AGENT_KEY",
  "KV_CONFIG_REST_API_TOKEN",
];

function proxyModules(): { name: string; source: string }[] {
  return readdirSync(PROXY_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(PROXY_DIR, name), "utf8") }));
}

describe("I7: proxy modules hold no funds-moving key and do not import the server env", () => {
  const modules = proxyModules();

  it("finds the proxy modules it is meant to check", () => {
    expect(modules.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        "config.ts",
        "ssrf.ts",
        "challenge.ts",
        "facilitator.ts",
        "flow.ts",
        "strkey.ts",
      ]),
    );
  });

  it.each(modules.map((m) => [m.name, m] as const))(
    "%s never references a server-only secret",
    (_name, module) => {
      for (const secret of SERVER_SECRET_NAMES) {
        expect(module.source, `${module.name} references ${secret}`).not.toContain(secret);
      }
    },
  );

  it.each(modules.map((m) => [m.name, m] as const))(
    "%s does not import the server env or server-only",
    (_name, module) => {
      expect(module.source).not.toMatch(/from\s+["'][^"']*env\.server["']/);
      expect(module.source).not.toMatch(/["']server-only["']/);
    },
  );
});
