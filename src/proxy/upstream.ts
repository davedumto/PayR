import { request as httpsRequest, type RequestOptions } from "node:https";

import type { Headers, UpstreamFetcher, UpstreamRequest, UpstreamResponse } from "@/proxy/flow";
import { type ResolvedAddress, type Resolver, resolveAndValidate } from "@/proxy/ssrf";

/**
 * The only way the proxy talks to a seller's upstream. The hostname is resolved and
 * validated once, and the TCP connection is pinned to that validated address. A second
 * DNS answer is never consulted, so DNS rebinding cannot move the connection to a
 * private address. The TLS SNI, certificate check and Host header still use the
 * original hostname. Redirects are never followed.
 */

/** Response headers the buyer never receives from the upstream (see ADR 0001, B6). */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "payment-required",
  "payment-response",
]);

/** Request headers the fetcher sets itself. Anything the buyer sent under these names is replaced. */
const FETCHER_OWNED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "connection",
]);

export class ResponseTooLargeError extends Error {
  constructor() {
    super("upstream response exceeded the byte cap");
    this.name = "ResponseTooLargeError";
  }
}

function timeoutError(): Error {
  const error = new Error("upstream timed out");
  error.name = "TimeoutError";
  return error;
}

/** Lookup function that returns the pinned address and ignores the requested hostname. */
export function pinnedLookup(address: ResolvedAddress) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (error: null, address: unknown, family?: number) => void,
  ): void => {
    if (options.all === true) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function requestHeaders(headers: Headers, host: string): Record<string, string> {
  const out: Record<string, string> = { host, "accept-encoding": "identity" };
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (FETCHER_OWNED_REQUEST_HEADERS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function responseHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(key)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export type FetchLimits = { readonly timeoutMs: number; readonly maxBytes: number };

export type PinnedOptions = {
  /** Extra trust anchors. Tests use it for a self-signed certificate. Production leaves it unset. */
  readonly trustedCa?: string;
};

/**
 * Performs one request to an already validated address. The address must come from
 * resolveAndValidate. This function does not resolve DNS and does not follow redirects.
 */
export function fetchPinned(
  request: UpstreamRequest,
  address: ResolvedAddress,
  limits: FetchLimits,
  options: PinnedOptions = {},
): Promise<UpstreamResponse> {
  const url = new URL(request.url);
  const port = url.port === "" ? 443 : Number(url.port);

  return new Promise<UpstreamResponse>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;

    const options_: RequestOptions = {
      host: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: requestHeaders(request.headers, url.host),
      // SNI and certificate verification use the hostname, not the pinned address.
      servername: url.hostname,
      ca: options.trustedCa,
      agent: false,
      lookup: pinnedLookup(address) as RequestOptions["lookup"],
    };

    const req = httpsRequest(options_, (res) => {
      res.on("data", (chunk: Uint8Array) => {
        total += chunk.byteLength;
        if (total > limits.maxBytes) {
          fail(new ResponseTooLargeError());
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({
          status: res.statusCode ?? 502,
          headers: responseHeaders(res.headers),
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", fail);
    });

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      reject(error);
    }

    // One deadline covers connect, headers and body. The socket timeout is a second guard.
    const deadline = setTimeout(() => fail(timeoutError()), limits.timeoutMs);
    req.setTimeout(limits.timeoutMs, () => fail(timeoutError()));
    req.on("error", fail);
    req.end(request.body);
  });
}

/**
 * The production upstream fetcher. Resolves and validates once, then pins the connection.
 * A blocked address rejects before any connection is made.
 */
export function createPinnedFetcher(
  config: { readonly resolve?: Resolver; readonly trustedCa?: string } = {},
): UpstreamFetcher {
  return {
    async fetch(request, limits) {
      const hostname = new URL(request.url).hostname;
      const address = await withDeadline(
        resolveAndValidate(hostname, config.resolve),
        limits.timeoutMs,
      );
      return fetchPinned(request, address, limits, { trustedCa: config.trustedCa });
    },
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
