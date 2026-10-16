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

// Transitive check: a proxy module must not reach env.server or server-only by any
// chain of imports, not only by a direct import.
const SRC_DIR = new URL("..", import.meta.url).pathname;
const SERVER_ENTRY = "env.server";
const FORBIDDEN_EXTERNAL = ["server-only"];
const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

function resolveImport(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) {
    return join(SRC_DIR, specifier.slice(2));
  }
  if (specifier.startsWith(".")) {
    return join(fromFile, "..", specifier);
  }
  return undefined;
}

function candidates(base: string): string[] {
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
}

function resolveFile(base: string): string | undefined {
  return candidates(base).find((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  });
}

function reachableFrom(entry: string): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]!;
      const local = resolveImport(file, specifier);
      if (local === undefined) {
        externals.add(specifier);
        continue;
      }
      const resolved = resolveFile(local);
      if (resolved) queue.push(resolved);
    }
  }
  return { files, externals };
}

describe("I7 (transitive): no proxy module reaches the server env through its imports", () => {
  const proxyEntries = readdirSync(PROXY_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(PROXY_DIR, name));

  it.each(proxyEntries.map((entry) => [entry.split("/").pop()!, entry] as const))(
    "%s does not transitively import env.server or server-only",
    (_name, entry) => {
      const { files, externals } = reachableFrom(entry);
      const reachedServer = [...files].some((file) => file.endsWith(`/${SERVER_ENTRY}.ts`));
      expect(reachedServer, `${entry} reaches ${SERVER_ENTRY}.ts`).toBe(false);
      for (const forbidden of FORBIDDEN_EXTERNAL) {
        expect([...externals], `${entry} reaches ${forbidden}`).not.toContain(forbidden);
      }
    },
  );

  it.each(proxyEntries.map((entry) => [entry.split("/").pop()!, entry] as const))(
    "%s imports no @x402/* package (decoded payloads stay opaque, zod-only)",
    (_name, entry) => {
      const { externals } = reachableFrom(entry);
      expect([...externals].filter((specifier) => specifier.startsWith("@x402/"))).toEqual([]);
    },
  );
});
