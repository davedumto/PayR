import { lookup } from "node:dns/promises";

/**
 * SSRF defence for seller target URLs.
 *
 * Two layers. validateTargetUrl runs on every config write and read and needs no
 * network. resolveAndValidate runs in Node immediately before the upstream
 * connection and checks every address the name resolves to. Edge cannot resolve
 * DNS, so Node is the only runtime that can enforce the second layer.
 */

export type TargetUrlCheck =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string };

const MAX_URL_LENGTH = 2048;
const DENIED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
const DENIED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOTTED_IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function ipv4Octets(address: string): [number, number, number, number] | undefined {
  if (!DOTTED_IPV4.test(address)) {
    return undefined;
  }
  const octets = address.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets as [number, number, number, number];
}

/** True only for globally routable IPv4 addresses. */
export function isPublicIPv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) {
    return false;
  }
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return false; // "this network", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands an IPv6 literal (no brackets) to eight 16-bit groups, or undefined. */
function ipv6Groups(address: string): number[] | undefined {
  let working = address.toLowerCase();
  const tailMatch = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(working);
  if (tailMatch) {
    const octets = ipv4Octets(tailMatch[1]!);
    if (!octets) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, tailMatch.index)}${hi}:${lo}`;
  }
  const halves = working.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group)))
    return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

/** True only for globally routable IPv6 addresses. Unknown forms are not public. */
export function isPublicIPv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) {
    return false;
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::ffff:a.b.c.d (IPv4-mapped) is judged by its embedded IPv4 address. Every
    // other address with a zero prefix (::, ::1, ::/96 IPv4-compatible) is denied.
    if (g5 === 0xffff) {
      return isPublicIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
    }
    return false;
  }
  if (g0 < 0x2000 || g0 > 0x3fff) return false; // outside global unicast 2000::/3
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 <= 0x01ff) return false; // IETF protocol assignments, Teredo, ORCHID
  if (g0 === 0x2002) return false; // 6to4 can embed private IPv4
  if (g0 === 0x3fff && g1 <= 0x0fff) return false; // documentation
  return true;
}

/** Static validation of a seller target URL. Needs no network. */
export function validateTargetUrl(input: string): TargetUrlCheck {
  if (input.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  if (/[^\x21-\x7e]/.test(input)) {
    return { ok: false, reason: "non-ascii-or-whitespace" };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "userinfo" };
  }
  if (url.port !== "") {
    return { ok: false, reason: "port" };
  }
  const host = url.hostname;
  if (host === "") {
    return { ok: false, reason: "empty-host" };
  }
  if (host.endsWith(".")) {
    return { ok: false, reason: "trailing-dot" };
  }
  if (host.startsWith("[")) {
    return isPublicIPv6(host.slice(1, -1))
      ? { ok: true, url }
      : { ok: false, reason: "non-public-ip" };
  }
  if (DOTTED_IPV4.test(host)) {
    return isPublicIPv4(host) ? { ok: true, url } : { ok: false, reason: "non-public-ip" };
  }
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { ok: false, reason: "idn" };
  }
  if (!DOMAIN_PATTERN.test(host)) {
    return { ok: false, reason: "invalid-host" };
  }
  if (DENIED_HOSTNAMES.has(host) || DENIED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "denied-name" };
  }
  return { ok: true, url };
}

export class SsrfBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`target blocked: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

export type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));

/**
 * Resolves the hostname and requires every returned address to be public. Returns
 * the first address, which the caller must connect to directly (IP pinning).
 */
export async function resolveAndValidate(
  hostname: string,
  resolve: Resolver = defaultResolver,
): Promise<ResolvedAddress> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new SsrfBlockedError("no-addresses");
  }
  for (const entry of addresses) {
    const isPublic = entry.family === 4 ? isPublicIPv4(entry.address) : isPublicIPv6(entry.address);
    if (!isPublic) {
      throw new SsrfBlockedError("resolves-to-non-public-address");
    }
  }
  return addresses[0]!;
}
