import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALLOWED_CONTENT_TYPES,
  GUARD_JSON_MAX_DEPTH,
  GUARD_JSON_MAX_KEYS,
  GUARD_URL_MAX_LENGTH,
  type GuardConfig,
  type GuardInput,
  jsonShapeProblem,
  runGuard,
} from "@/proxy/guard";

const CONFIG: GuardConfig = {
  allowedMethods: ["GET", "HEAD"],
  maxRequestBytes: 1024,
  allowedContentTypes: DEFAULT_ALLOWED_CONTENT_TYPES,
};
const enc = (text: string) => new TextEncoder().encode(text);

function input(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    method: "GET",
    path: "/forecast",
    headers: {},
    body: new Uint8Array(),
    config: CONFIG,
    ...overrides,
  };
}

function nested(depth: number): string {
  return `${"[".repeat(depth)}0${"]".repeat(depth)}`;
}

describe("runGuard: method, URL, size", () => {
  it.each([
    ["GET", true],
    ["HEAD", true],
    ["POST", false],
    ["get", false],
    ["TRACE", false],
    ["CONNECT", false],
  ])("method %s allowed=%s", (method, allowed) => {
    expect(
      runGuard(input({ method, config: { ...CONFIG, allowedMethods: ["GET", "HEAD"] } })).ok,
    ).toBe(allowed);
  });

  it("returns 405 for a disallowed method", () => {
    expect(runGuard(input({ method: "DELETE" }))).toMatchObject({ ok: false, status: 405 });
  });

  it("accepts a path exactly at the length cap and rejects one byte over", () => {
    const atCap = `/${"a".repeat(GUARD_URL_MAX_LENGTH - 1)}`;
    expect(runGuard(input({ path: atCap })).ok).toBe(true);
    expect(runGuard(input({ path: `${atCap}a` }))).toMatchObject({ ok: false, status: 414 });
  });

  it("accepts a body exactly at the byte cap and rejects one byte over", () => {
    expect(
      runGuard(
        input({
          method: "GET",
          body: new Uint8Array(1024).fill(97),
          headers: { "content-type": "text/plain" },
        }),
      ).ok,
    ).toBe(true);
    expect(
      runGuard(
        input({ body: new Uint8Array(1025).fill(97), headers: { "content-type": "text/plain" } }),
      ),
    ).toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it("rejects an oversized body before looking at its type", () => {
    expect(runGuard(input({ body: new Uint8Array(4096) }))).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});

describe("runGuard: content type and charset", () => {
  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["APPLICATION/JSON", true],
    ["text/plain", true],
    ["application/x-www-form-urlencoded", true],
    ["text/html", false],
    ["application/xml", false],
    ["multipart/form-data", false],
    ["application/octet-stream", false],
    ["application/json; charset=utf-16", false],
    ["image/png", false],
  ])("Content-Type %s allowed=%s", (contentType, allowed) => {
    const result = runGuard(
      input({ method: "GET", headers: { "content-type": contentType }, body: enc("{}") }),
    );
    expect(result.ok).toBe(allowed);
    if (!allowed) expect(result).toMatchObject({ status: 415 });
  });

  it("requires a Content-Type when there is a body", () => {
    expect(runGuard(input({ body: enc("x") }))).toMatchObject({
      ok: false,
      status: 415,
      reason: "content-type-required",
    });
  });

  it("allows an empty body with no Content-Type", () => {
    expect(runGuard(input({ body: new Uint8Array() })).ok).toBe(true);
  });

  it("honours a configured content type", () => {
    const config = { ...CONFIG, allowedContentTypes: ["application/xml"] };
    expect(
      runGuard(input({ config, headers: { "content-type": "application/xml" }, body: enc("<a/>") }))
        .ok,
    ).toBe(true);
    expect(
      runGuard(input({ config, headers: { "content-type": "application/json" }, body: enc("{}") }))
        .ok,
    ).toBe(false);
  });
});

describe("runGuard: JSON bodies", () => {
  const json = { "content-type": "application/json" };

  it.each([
    ["a small object", '{"a":1}', true],
    ["an array", "[1,2,3]", true],
    ["invalid JSON", "{not json", false],
    ["a truncated document", '{"a":', false],
    ["invalid UTF-8", "\xff\xfe", false],
    ["a bare string", '"ok"', true],
  ])("JSON body %s -> ok=%s", (_name, body, ok) => {
    expect(runGuard(input({ headers: json, body: enc(body) })).ok).toBe(ok);
  });

  it(`accepts nesting exactly at ${GUARD_JSON_MAX_DEPTH} and rejects one level deeper`, () => {
    expect(runGuard(input({ headers: json, body: enc(nested(GUARD_JSON_MAX_DEPTH)) })).ok).toBe(
      true,
    );
    expect(
      runGuard(input({ headers: json, body: enc(nested(GUARD_JSON_MAX_DEPTH + 1)) })),
    ).toMatchObject({
      ok: false,
      reason: "json-too-deep",
    });
  });

  it(`accepts ${GUARD_JSON_MAX_KEYS} keys and rejects one more`, () => {
    const keys = (n: number) => `{${Array.from({ length: n }, (_, i) => `"k${i}":1`).join(",")}}`;
    const roomy = { ...CONFIG, maxRequestBytes: 1_048_576 };
    expect(
      runGuard(input({ config: roomy, headers: json, body: enc(keys(GUARD_JSON_MAX_KEYS)) })).ok,
    ).toBe(true);
    expect(
      runGuard(input({ config: roomy, headers: json, body: enc(keys(GUARD_JSON_MAX_KEYS + 1)) })),
    ).toMatchObject({
      reason: "json-too-many-keys",
    });
  });

  it("rejects pathological nesting without overflowing the stack", () => {
    const deep = nested(100_000);
    expect(() => runGuard(input({ headers: json, body: enc(deep) }))).not.toThrow();
    expect(runGuard(input({ headers: json, body: enc(deep) })).ok).toBe(false);
  });

  it("does not parse a text/plain body as JSON", () => {
    expect(
      runGuard(input({ headers: { "content-type": "text/plain" }, body: enc("{not json") })).ok,
    ).toBe(true);
  });
});

describe("runGuard: NUL bytes", () => {
  it("rejects a raw NUL byte in the body", () => {
    expect(
      runGuard(
        input({ headers: { "content-type": "text/plain" }, body: new Uint8Array([0x61, 0, 0x62]) }),
      ),
    ).toMatchObject({
      reason: "nul-in-body",
    });
  });

  it("rejects a raw NUL in the path", () => {
    expect(runGuard(input({ path: "/a\u0000b" }))).toMatchObject({ reason: "nul-in-path" });
  });

  it("rejects a NUL in a header value", () => {
    expect(runGuard(input({ headers: { "user-agent": "x\u0000y" } }))).toMatchObject({
      reason: "nul-in-header",
    });
  });

  it("rejects a NUL in a header name", () => {
    expect(runGuard(input({ headers: { "x\u0000": "1" } }))).toMatchObject({
      reason: "nul-in-header",
    });
  });
});

describe("runGuard: header allowlist", () => {
  it.each([
    ["accept", "*/*", true],
    ["accept-language", "en", true],
    ["content-type", "text/plain", true],
    ["user-agent", "agent/1", true],
    ["x-request-id", "abc", true],
    ["cookie", "session=1", false],
    ["authorization", "Bearer x", false],
    ["host", "proxy.example.test", false],
    ["payment-signature", "abc", false],
    ["x-forwarded-for", "10.0.0.1", false],
    ["referer", "https://buyer.test", false],
    ["x-payr-origin-key", "secret", false],
    ["connection", "keep-alive", false],
  ])("header %s forwarded=%s", (name, value, forwarded) => {
    const result = runGuard(input({ headers: { [name]: value } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.headers).includes(name)).toBe(forwarded);
    }
  });

  it("matches header names regardless of case", () => {
    const result = runGuard(input({ headers: { Accept: "*/*", COOKIE: "x=1" } }));
    expect(result.ok && result.headers).toEqual({ accept: "*/*" });
  });
});

describe("jsonShapeProblem", () => {
  it("returns undefined for a value within limits", () => {
    expect(jsonShapeProblem({ a: [1, { b: 2 }] })).toBeUndefined();
  });

  it("counts keys in arrays of objects", () => {
    const many = Array.from({ length: GUARD_JSON_MAX_KEYS + 1 }, (_, i) => ({ [`k${i}`]: 1 }));
    expect(jsonShapeProblem(many)).toBe("json-too-many-keys");
  });
});
