/**
 * Builds the upstream URL for a proxied request. The seller's target URL fixes
 * the origin and the base path. The buyer's path is appended to the base, and
 * nothing the buyer sends can change either one.
 *
 * Rejected before any URL is built: dot segments (raw or encoded), double
 * encoding, encoded dots, encoded separators, backslashes, NUL and other control
 * characters (raw or encoded), and fragments. Checked after building: same
 * origin, and a pathname inside the base path on a segment boundary.
 */

export const UPSTREAM_PATH_MAX_LENGTH = 2048;

export type UpstreamUrl =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string };

const RAW_CONTROL = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

/** True if pathname is the base path or lies under it, on a segment boundary. */
export function isInsideBase(pathname: string, basePath: string): boolean {
  const base = basePath.replace(/\/+$/, "");
  if (base === "") {
    return pathname.startsWith("/");
  }
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function buildUpstreamUrl(targetUrl: string, path: string): UpstreamUrl {
  if (path.length > UPSTREAM_PATH_MAX_LENGTH) return { ok: false, reason: "path-too-long" };
  if (!path.startsWith("/") || path.startsWith("//"))
    return { ok: false, reason: "path-must-start-with-single-slash" };
  if (RAW_CONTROL.test(path)) return { ok: false, reason: "control-character" };
  if (path.includes("\\")) return { ok: false, reason: "backslash" };
  if (path.includes("#")) return { ok: false, reason: "fragment" };

  const queryAt = path.indexOf("?");
  const pathPart = queryAt === -1 ? path : path.slice(0, queryAt);
  const queryPart = queryAt === -1 ? "" : path.slice(queryAt + 1);

  if (ENCODED_CONTROL.test(pathPart)) return { ok: false, reason: "encoded-control-character" };
  if (/%25/i.test(pathPart)) return { ok: false, reason: "double-encoding" };
  if (/%2e/i.test(pathPart)) return { ok: false, reason: "encoded-dot" };
  if (/%2f|%5c/i.test(pathPart)) return { ok: false, reason: "encoded-separator" };
  if (pathPart.split("/").some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "dot-segment" };
  }

  const base = new URL(targetUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(base.origin);
  url.pathname = `${basePath}${pathPart}`;
  url.search = queryPart === "" ? "" : `?${queryPart}`;

  if (url.origin !== base.origin) return { ok: false, reason: "origin-changed" };
  if (!isInsideBase(url.pathname, basePath)) return { ok: false, reason: "outside-base-path" };
  if (url.pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "normalised-dot-segment" };
  }
  return { ok: true, url };
}
