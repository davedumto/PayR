import { describe, expect, it } from "vitest";

import { buildUpstreamUrl, isInsideBase, UPSTREAM_PATH_MAX_LENGTH } from "@/proxy/url";

const BASE = "https://api.seller.example/v1";

type Row = readonly [name: string, path: string, reason?: string, expected?: string];

// Each rejected row names the rule it exercises. Accepted rows give the exact URL.
const ROWS: readonly Row[] = [
  ["plain path under the base", "/forecast", undefined, "https://api.seller.example/v1/forecast"],
  ["root path", "/", undefined, "https://api.seller.example/v1/"],
  [
    "query string is kept",
    "/forecast?city=lisbon",
    undefined,
    "https://api.seller.example/v1/forecast?city=lisbon",
  ],
  [
    "dots inside a name, not a segment",
    "/a/..b/c...",
    undefined,
    "https://api.seller.example/v1/a/..b/c...",
  ],
  [
    "authority-looking path stays on the origin",
    "/@evil.test/x",
    undefined,
    "https://api.seller.example/v1/@evil.test/x",
  ],
  [
    "protocol-relative inside the query stays put",
    "/x?next=//evil.test",
    undefined,
    "https://api.seller.example/v1/x?next=//evil.test",
  ],
  ["the brief's traversal: raw dot-dot", "/../admin", "dot-segment"],
  ["the brief's traversal: encoded dot-dot", "/%2e%2e/admin", "encoded-dot"],
  ["encoded dot-dot, upper case", "/%2E%2E/admin", "encoded-dot"],
  ["mixed raw and encoded dots", "/.%2e/admin", "encoded-dot"],
  ["double-encoded dot-dot", "/%252e%252e/admin", "double-encoding"],
  ["encoded percent alone (double-encoding risk)", "/%25", "double-encoding"],
  ["dot segment in the middle", "/a/./b", "dot-segment"],
  ["dot-dot in the middle", "/a/../b", "dot-segment"],
  ["encoded dot in the middle", "/a/%2e/b", "encoded-dot"],
  ["backslash traversal", "/a\\..\\admin", "backslash"],
  ["encoded backslash", "/a%5c..%5cadmin", "encoded-separator"],
  ["encoded forward slash", "/a%2fb", "encoded-separator"],
  ["encoded NUL", "/a%00b", "encoded-control-character"],
  ["encoded newline", "/a%0ab", "encoded-control-character"],
  ["encoded DEL", "/a%7fb", "encoded-control-character"],
  ["raw NUL", "/a\u0000b", "control-character"],
  ["raw newline", "/a\nb", "control-character"],
  ["raw tab", "/a\tb", "control-character"],
  ["double leading slash (host confusion)", "//evil.test/x", "path-must-start-with-single-slash"],
  ["no leading slash", "forecast", "path-must-start-with-single-slash"],
  ["fragment", "/a#frag", "fragment"],
  ["path over the length cap", `/${"a".repeat(UPSTREAM_PATH_MAX_LENGTH)}`, "path-too-long"],
  ["three dots is a name, not a segment", "/...", undefined, "https://api.seller.example/v1/..."],
];

describe("buildUpstreamUrl (B1)", () => {
  it.each(ROWS)("%s", (_name, path, reason, expected) => {
    const result = buildUpstreamUrl(BASE, String(path));
    if (reason === undefined) {
      expect(result.ok).toBe(true);
      if (result.ok && expected !== undefined) {
        expect(result.url.toString()).toBe(expected);
      }
    } else {
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it("keeps the origin and base path for a base with a trailing slash", () => {
    const result = buildUpstreamUrl("https://api.seller.example/v1/", "/x");
    expect(result.ok && result.url.toString()).toBe("https://api.seller.example/v1/x");
  });

  it("works with an empty base path", () => {
    const result = buildUpstreamUrl("https://api.seller.example", "/x/y");
    expect(result.ok && result.url.toString()).toBe("https://api.seller.example/x/y");
  });

  it("never returns a URL with a different origin", () => {
    for (const path of ["/x", "/@evil.test", "/%40evil.test/x", "/a?@evil.test"]) {
      const result = buildUpstreamUrl(BASE, path);
      if (result.ok) {
        expect(result.url.origin).toBe("https://api.seller.example");
      }
    }
  });
});

describe("isInsideBase (segment boundary)", () => {
  it.each([
    ["/v1", "/v1", true],
    ["/v1/x", "/v1", true],
    ["/v10/x", "/v1", false],
    ["/v1x", "/v1", false],
    ["/other", "/v1", false],
    ["/v1/", "/v1/", true],
    ["/anything", "", true],
    ["/", "", true],
  ])("pathname %s under base %s -> %s", (pathname, base, expected) => {
    expect(isInsideBase(pathname, base)).toBe(expected);
  });
});
