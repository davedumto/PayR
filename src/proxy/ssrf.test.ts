import { describe, expect, it } from "vitest";

import {
  isPublicIPv4,
  isPublicIPv6,
  resolveAndValidate,
  SsrfBlockedError,
  validateTargetUrl,
} from "@/proxy/ssrf";

type Case = { readonly input: string; readonly ok: boolean; readonly reason?: string };

// Expected reasons were worked out from the WHATWG URL rules before running the
// code. Bypass strings are included on purpose.
const TARGET_URL_CASES: readonly Case[] = [
  { input: "https://api.example.com/v1", ok: true },
  { input: "https://api.example.com", ok: true },
  { input: "https://EXAMPLE.com", ok: true },
  { input: "https://api.example.com:443/", ok: true },
  { input: "https://api.example.com/path?x=1#frag", ok: true },
  { input: "https://8.8.8.8/", ok: true },
  { input: "https://[2606:4700:4700::1111]/", ok: true },
  { input: "https://[::ffff:8.8.8.8]/", ok: true },
  { input: "https://[2001:4860:4860::8888]/", ok: true },
  { input: "http://api.example.com/", ok: false, reason: "scheme" },
  { input: "ftp://api.example.com/", ok: false, reason: "scheme" },
  { input: "javascript:alert(1)", ok: false, reason: "scheme" },
  { input: "file:///etc/passwd", ok: false, reason: "scheme" },
  { input: "https://user:pass@api.example.com/", ok: false, reason: "userinfo" },
  { input: "https://user@api.example.com/", ok: false, reason: "userinfo" },
  { input: "https://example.com:443@evil.test/", ok: false, reason: "userinfo" },
  { input: "https://api.example.com:8443/", ok: false, reason: "port" },
  { input: "https://api.example.com:80/", ok: false, reason: "port" },
  { input: "https://localhost/", ok: false, reason: "invalid-host" },
  { input: "https://LOCALHOST/", ok: false, reason: "invalid-host" },
  { input: "https://metadata/", ok: false, reason: "invalid-host" },
  { input: "https://app.localhost/", ok: false, reason: "denied-name" },
  { input: "https://printer.local/", ok: false, reason: "denied-name" },
  { input: "https://db.internal/", ok: false, reason: "denied-name" },
  { input: "https://metadata.google.internal/", ok: false, reason: "denied-name" },
  { input: "https://svc.home.arpa/", ok: false, reason: "denied-name" },
  { input: "https://api.example.com./", ok: false, reason: "trailing-dot" },
  { input: "https://xn--pple-43d.com/", ok: false, reason: "idn" },
  { input: "https://api_example.com/", ok: false, reason: "invalid-host" },
  { input: "https://-bad.example.com/", ok: false, reason: "invalid-host" },
  { input: "https://bad-.example.com/", ok: false, reason: "invalid-host" },
  { input: "https://127.0.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://127.1/", ok: false, reason: "non-public-ip" },
  { input: "https://2130706433/", ok: false, reason: "non-public-ip" },
  { input: "https://0x7f000001/", ok: false, reason: "non-public-ip" },
  { input: "https://0177.0.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://0x7f.0.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://%31%32%37.0.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://10.0.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://169.254.169.254/", ok: false, reason: "non-public-ip" },
  { input: "https://172.16.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://192.168.1.1/", ok: false, reason: "non-public-ip" },
  { input: "https://100.64.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://0.0.0.0/", ok: false, reason: "non-public-ip" },
  { input: "https://224.0.0.1/", ok: false, reason: "non-public-ip" },
  { input: "https://255.255.255.255/", ok: false, reason: "non-public-ip" },
  { input: "https://[::1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[::]/", ok: false, reason: "non-public-ip" },
  { input: "https://[fe80::1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[fc00::1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[ff02::1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[::ffff:127.0.0.1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[::ffff:10.0.0.1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[::ffff:169.254.169.254]/", ok: false, reason: "non-public-ip" },
  { input: "https://[::127.0.0.1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[64:ff9b::8.8.8.8]/", ok: false, reason: "non-public-ip" },
  { input: "https://[2002:7f00:1::]/", ok: false, reason: "non-public-ip" },
  { input: "https://[2001:db8::1]/", ok: false, reason: "non-public-ip" },
  { input: "https://[2001::1]/", ok: false, reason: "non-public-ip" },
  { input: "https://127.0.0.1.nip.io/", ok: true },
  { input: "", ok: false, reason: "unparseable" },
  { input: "https://", ok: false, reason: "unparseable" },
  { input: "not a url", ok: false, reason: "non-ascii-or-whitespace" },
  { input: "https://аpple.com/", ok: false, reason: "non-ascii-or-whitespace" },
  { input: "https://api.example.com\u0000/", ok: false, reason: "non-ascii-or-whitespace" },
  { input: `https://example.com/${"a".repeat(2100)}`, ok: false, reason: "too-long" },
];

describe("validateTargetUrl", () => {
  it.each(TARGET_URL_CASES)("$input -> ok=$ok $reason", ({ input, ok, reason }) => {
    const result = validateTargetUrl(input);
    expect(result.ok).toBe(ok);
    if (!result.ok && reason !== undefined) {
      expect(result.reason).toBe(reason);
    }
  });

  it("treats a backslash as a path separator, so the host is example.com", () => {
    const result = validateTargetUrl("https://example.com\\@evil.test/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("example.com");
    }
  });

  it("uses the fragment-separated host, not the text after '#@'", () => {
    const result = validateTargetUrl("https://evil.test#@example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("evil.test");
    }
  });
});

const IPV4_CASES: readonly (readonly [string, boolean])[] = [
  ["1.1.1.1", true],
  ["9.255.255.255", true],
  ["10.0.0.0", false],
  ["10.255.255.255", false],
  ["11.0.0.0", true],
  ["100.63.255.255", true],
  ["100.64.0.0", false],
  ["100.127.255.255", false],
  ["100.128.0.0", true],
  ["127.0.0.1", false],
  ["128.0.0.0", true],
  ["169.253.255.255", true],
  ["169.254.0.1", false],
  ["172.15.255.255", true],
  ["172.16.0.0", false],
  ["172.31.255.255", false],
  ["172.32.0.0", true],
  ["192.0.0.1", false],
  ["192.0.1.1", true],
  ["192.0.2.1", false],
  ["192.88.99.1", false],
  ["192.167.255.255", true],
  ["192.168.0.1", false],
  ["192.169.0.1", true],
  ["198.17.255.255", true],
  ["198.18.0.1", false],
  ["198.19.255.255", false],
  ["198.20.0.0", true],
  ["198.51.100.1", false],
  ["203.0.113.1", false],
  ["223.255.255.255", true],
  ["224.0.0.0", false],
  ["240.0.0.1", false],
  ["256.1.1.1", false],
  ["1.2.3", false],
  ["not-an-ip", false],
];

describe("isPublicIPv4", () => {
  it.each(IPV4_CASES)("%s -> %s", (address, expected) => {
    expect(isPublicIPv4(address)).toBe(expected);
  });
});

const IPV6_CASES: readonly (readonly [string, boolean])[] = [
  ["::", false],
  ["::1", false],
  ["2001:4860:4860::8888", true],
  ["2606:4700:4700::1111", true],
  ["fe80::1", false],
  ["fc00::1", false],
  ["fd12:3456::1", false],
  ["ff02::1", false],
  ["::ffff:8.8.8.8", true],
  ["::ffff:127.0.0.1", false],
  ["::ffff:169.254.169.254", false],
  ["::8.8.8.8", false],
  ["64:ff9b::808:808", false],
  ["2002::1", false],
  ["2001:db8::1", false],
  ["2001::1", false],
  ["3fff:fff::1", false],
  ["3fff:1000::1", true],
  ["1:2:3:4:5:6:7:8:9", false],
  ["1::2::3", false],
  ["12345::", false],
  ["not-an-ip", false],
];

describe("isPublicIPv6", () => {
  it.each(IPV6_CASES)("%s -> %s", (address, expected) => {
    expect(isPublicIPv6(address)).toBe(expected);
  });
});

describe("resolveAndValidate", () => {
  it("returns the first address when every resolved address is public", async () => {
    const pinned = await resolveAndValidate("api.example.com", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
    expect(pinned).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("blocks when any one resolved address is private, even if others are public", async () => {
    await expect(
      resolveAndValidate("rebind.example.com", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a name that resolves to the cloud metadata address", async () => {
    await expect(
      resolveAndValidate("metadata-alias.example.com", async () => [
        { address: "169.254.169.254", family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: "resolves-to-non-public-address" });
  });

  it("blocks an IPv6 loopback answer", async () => {
    await expect(
      resolveAndValidate("v6.example.com", async () => [{ address: "::1", family: 6 }]),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("accepts a public IPv6 answer", async () => {
    const pinned = await resolveAndValidate("v6.example.com", async () => [
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(pinned.family).toBe(6);
  });

  it("blocks when DNS returns no addresses", async () => {
    await expect(resolveAndValidate("empty.example.com", async () => [])).rejects.toMatchObject({
      reason: "no-addresses",
    });
  });
});
