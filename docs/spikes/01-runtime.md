# Spike 01: runtime for the paywall proxy

Status: research only. No prototype code was run. Items marked UNVERIFIED need a prototype before Brief 2b.

## Sources checked (2026-10-14)

- Next.js proxy file convention, Next docs (page version 16.4.0): nextjs.org/docs/app/api-reference/file-conventions/proxy
- Next.js route segment config (updated 2026-10-01): nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
- Vercel Node.js runtime: vercel.com/docs/functions/runtimes/node-js
- Vellar docs (real paths are `/docs/<section>.md`, not the paths in the brief): docs.vellar.xyz/docs/reference/error-codes.md, /docs/concepts/payment-loop.md, /docs/architecture/settlement-path.md, /docs/facilitator.md, /docs/sellers/charge-for-an-endpoint.md, /docs/concepts/exact-scheme.md, /docs/api-reference.md, /docs/x402.md
- @x402/core 2.28.0 and @x402/stellar 2.28.0 and @stellar/stellar-sdk 16.3.0 (npm tarballs, read from dist and package.json)

Context7 was unavailable (monthly quota exceeded), so Next.js facts come from the Next docs pages above.

## (a) Next.js 16: Edge runtime and middleware

- `proxy.ts` replaces `middleware.ts`. The docs say the middleware file convention is "deprecated and has been renamed to proxy".
- Proxy "defaults to the Node.js runtime". "The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."
- Route segment config lists `runtime` as `'nodejs' | 'edge' (deprecated)`.

Conclusion: there is no supported, non-deprecated Edge runtime in Next 16 for either proxy or route handlers. The brief's default (answer unpaid requests at Edge) would rely on a deprecated API. The brief's `env.edge` module boundary still works as a module boundary, but no code will run on the Next Edge runtime.

## (b) @x402/core and @x402/stellar under Edge

- `@x402/core` 2.28.0: no Node built-in imports in dist. Runtime dependency `zod ^3.24.2`. The repo uses zod 4, so using core at runtime would bundle a second zod major into any Edge bundle. Core types are still usable (`import type`).
- `@x402/stellar` 2.28.0: `engines.node >=22`. Depends on `@stellar/stellar-sdk ^16.3.0`, which is 34 MB unpacked and imports `crypto`, `http`, `https`, `zlib`, `stream`, `path`, `url`, `util`, `events` (`axios` and `eventsource` are both pulled in).
- Neither package is needed on the request path. Verify and settle are delegated to the Vellar HTTP facilitator, which is a plain HTTPS API.

Conclusion: do not import `@x402/stellar` in any module. Import only types from `@x402/core`, and write our own zod 4 validators. The Stellar SDK is not needed for the proxy. Not verified by an actual bundle build; the Node built-in scan is the evidence.

## (c) IP-pinned upstream fetch on Vercel Node runtime

- Vercel Node runtime: "Vercel Functions using the Node.js runtime support all Node.js APIs".
- Pinning design: resolve with `dns.lookup(host, { all: true })`. Reject if any address is non-public (SSRF module). Connect with `https.request({ host: pinnedIp, servername: host, headers: { Host: host } })`, or pass `lookup` returning the pinned address. No redirects (`redirect: manual` semantics). Enforce byte cap while streaming.
- Edge cannot do DNS resolution, so it cannot fully stop DNS-rebinding SSRF. The Node runtime can.

Conclusion: pinned fetch is available in the Node runtime. UNVERIFIED on Vercel: a live prototype that connects to a validated IP with SNI. Do this in Brief 2b, with a test against a local TLS server.

## Vellar wire facts (verified against the docs and the x402 SDK types)

- Buyer retry header: `PAYMENT-SIGNATURE`. Challenge header: `PAYMENT-REQUIRED`. Settle receipt header: `PAYMENT-RESPONSE`. The brief's `x-x402-receipt` is wrong.
- Header encoding: base64 of JSON (`encodePaymentRequiredHeader` and `encodePaymentSignatureHeader` in @x402/core). Decoding must validate base64 first.
- `/verify` request: `{ x402Version, paymentPayload, paymentRequirements }`. Response: `{ isValid, invalidReason?, invalidMessage?, payer? }`. Decision is `isValid` in the body.
- `/settle` request: same shape as verify. Response: `{ success, transaction, network, errorReason?, errorMessage?, payer?, amount? }`. Decision is `success` plus the `transaction` field.
- Settle retry rules (settlement-path and error-codes):
  - success with non-empty `transaction`: settled.
  - `success: false` with empty `transaction`: nothing spent. Retry safe, but the buyer must re-sign.
  - `success: false` with non-empty `transaction`: fees charged. Terminal.
  - `503 settlement_refused` with `reason`: refused before submission. Reasons documented: `sponsor_balance_low`, `spend_ceiling`, `rate_limited_payto`.
  - `503 service_paused`: refused before any spend. Retry later.
  - `400 invalid_payload`: malformed body.
  - `fee_exceeds_maximum`: refused before submission.
- Verify-stage failures: no settle header, no retry. Re-sign if the code says so.
- Amounts are base-unit strings with 7 decimals.
- `payTo` must match the 402 challenge exactly. A classic `G...` recipient needs a trustline to the asset, or settlement fails with `invalid_exact_stellar_payload_missing_trustline_recipient`.
- Request bodies are capped at 32 KiB.

## UNVERIFIED or not documented

- The exact `exact`-scheme payload JSON the buyer signs. Documented only as a Soroban authorization entry for `transfer(from, to, amount)`. The proxy will treat `paymentPayload.payload` as opaque and check only `accepted` against our requirements.
- The `/verify` and `/settle` error body shape for `invalid_payload`.
- The docs give inconsistent amount examples (`PRICE_ATOMIC=1000000` and `"0.5"` in an SDK snippet). We use base units, per the exact-scheme page.

## Recommendation

1. Run everything on the Node runtime: proxy logic, challenge issuance, verify, forward, settle. Do not rely on Edge.
2. Keep unpaid requests cheap in Node. The 402 path needs one KV config read and no upstream call.
3. Put IP-pinned, validated outbound fetches in Node only.
4. Keep the `env.edge` naming as a module boundary for "safe for any runtime", but do not ship an Edge runtime.
5. Revisit an Edge fast path only when Next supports one without deprecated APIs, or when it can live outside Next.

Open for CTO decision: this changes the default in the brief. Shall I proceed on the Node-only plan?
