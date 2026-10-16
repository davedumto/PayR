import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPinnedFetcher, fetchPinned, pinnedLookup } from "@/proxy/upstream";
import { SsrfBlockedError, type Resolver } from "@/proxy/ssrf";

/**
 * The TLS certificate is generated at test time with openssl and never committed.
 * The server listens on 127.0.0.1 and presents a certificate for "localhost".
 */

const LOOPBACK = { address: "127.0.0.1", family: 4 as const };
const LIMITS = { timeoutMs: 2_000, maxBytes: 4_096 };

let dir: string;
let caPem: string;
let server: Server;
let port: number;
let seen: { host?: string; servername?: string; method?: string; path?: string }[];
let handler: (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "payr-upstream-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  caPem = readFileSync(certPath, "utf8");
  const key = readFileSync(keyPath, "utf8");

  seen = [];
  handler = (_req, res) => {
    res.statusCode = 200;
    res.end("pong");
  };
  server = createServer({ key, cert: caPem }, (req, res) => {
    seen.push({
      host: req.headers.host,
      servername: (req.socket as unknown as { servername?: string }).servername,
      method: req.method,
      path: req.url,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function upstream(path = "/x") {
  return {
    method: "GET",
    url: `https://localhost:${port}${path}`,
    headers: { accept: "text/plain", host: "buyer.example", "accept-encoding": "gzip" },
    body: undefined,
  };
}

describe("fetchPinned: connects to the pinned address with the hostname for SNI and Host", () => {
  it("returns the body, sends Host and SNI as the hostname, and asks for identity encoding", async () => {
    seen = [];
    handler = (_req, res) => res.end("pong");
    const response = await fetchPinned(upstream(), LOOPBACK, LIMITS, { trustedCa: caPem });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("pong");
    expect(seen[0]).toMatchObject({
      host: `localhost:${port}`,
      servername: "localhost",
      path: "/x",
    });
  });

  it("strips content-encoding and upstream payment headers from the response", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.setHeader("content-encoding", "gzip");
      res.setHeader("payment-required", "upstream-challenge");
      res.setHeader("payment-response", "upstream-receipt");
      res.end("ok");
    };
    const response = await fetchPinned(upstream(), LOOPBACK, LIMITS, { trustedCa: caPem });
    expect(response.headers).toHaveProperty("content-type", "text/plain");
    expect(response.headers).not.toHaveProperty("content-encoding");
    expect(response.headers).not.toHaveProperty("payment-required");
    expect(response.headers).not.toHaveProperty("payment-response");
  });

  it("never follows a redirect: a 302 is returned as is and the Location is not fetched", async () => {
    seen = [];
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "https://elsewhere.test/");
      res.end();
    };
    const response = await fetchPinned(upstream(), LOOPBACK, LIMITS, { trustedCa: caPem });
    expect(response.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it("stops at the byte cap and rejects", async () => {
    handler = (_req, res) => res.end("x".repeat(LIMITS.maxBytes * 2));
    await expect(
      fetchPinned(upstream(), LOOPBACK, { ...LIMITS, maxBytes: 100 }, { trustedCa: caPem }),
    ).rejects.toThrow(/byte cap/);
  });

  it("rejects with TimeoutError when the upstream never answers", async () => {
    handler = () => undefined;
    const started = Date.now();
    const error = await fetchPinned(
      upstream(),
      LOOPBACK,
      { timeoutMs: 200, maxBytes: LIMITS.maxBytes },
      { trustedCa: caPem },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects a certificate the system does not trust", async () => {
    handler = (_req, res) => res.end("pong");
    await expect(fetchPinned(upstream(), LOOPBACK, LIMITS)).rejects.toThrow();
  });
});

describe("createPinnedFetcher: the hostname is resolved once and validated before connecting", () => {
  it("a hostname that resolves to a private address is blocked before any connection", async () => {
    seen = [];
    const resolve = vi.fn<Resolver>(async () => [LOOPBACK]);
    const fetcher = createPinnedFetcher({ resolve, trustedCa: caPem });
    await expect(fetcher.fetch(upstream(), LIMITS)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
  });

  it("DNS rebinding: a second answer that differs from the validated one is never consulted", async () => {
    const publicA = { address: "93.184.216.34", family: 4 as const };
    const privateB = { address: "10.0.0.5", family: 4 as const };
    const resolve = vi
      .fn<Resolver>()
      .mockResolvedValueOnce([publicA])
      .mockResolvedValue([privateB]);
    // The pinned lookup must answer with the validated address, whatever DNS says now.
    const lookup = pinnedLookup(publicA);
    const answer = await new Promise<unknown>((resolveAnswer) =>
      lookup("api.seller.example", { all: false }, (_err, address) => resolveAnswer(address)),
    );
    expect(answer).toBe("93.184.216.34");
    await resolve("api.seller.example");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("the pinned lookup returns every address array shape the client may ask for", async () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    const all = await new Promise<unknown>((resolveAnswer) =>
      lookup("api.seller.example", { all: true }, (_err, addresses) => resolveAnswer(addresses)),
    );
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
