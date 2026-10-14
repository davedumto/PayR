import { describe, expect, it } from "vitest";

import nextConfig, { securityHeaders } from "../../next.config";

async function servedHeaders(): Promise<Map<string, string>> {
  // Read the same rules Next.js serves, not just the exported array.
  const rules = await nextConfig.headers?.();
  const all = rules?.find((rule) => rule.source === "/:path*")?.headers ?? [];
  return new Map(all.map((header) => [header.key, header.value]));
}

describe("security headers", () => {
  it("serves every header from the single exported list", async () => {
    const served = await servedHeaders();
    expect([...served.keys()].sort()).toEqual(securityHeaders.map((h) => h.key).sort());
  });

  it("sets Strict-Transport-Security to two years with subdomains", async () => {
    expect((await servedHeaders()).get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  it("sets Permissions-Policy to deny sensors and payment, allowing WebAuthn for self", async () => {
    expect((await servedHeaders()).get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    );
  });

  it("keeps the existing baseline headers", async () => {
    const served = await servedHeaders();
    expect(served.get("X-Content-Type-Options")).toBe("nosniff");
    expect(served.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(served.get("X-Frame-Options")).toBe("DENY");
    expect(served.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(served.get("Content-Security-Policy")).not.toContain("unsafe-eval");
  });
});
