# Threat model: paywall proxy

Scope: the Node-only proxy core in `src/proxy/`. Routes, real KV adapters, rate
limits and the audit log are Brief 2b and are not covered here.

## Assets and actors

- **Seller funds.** Only the facilitator moves funds. The proxy holds no key that can
  move them (I7, enforced by the boundary tests).
- **Seller upstream.** The seller's API behind the proxy. It must receive a call only
  after payment is verified and settled (I1, I2).
- **Buyer.** Sends a signed payment and a request. Untrusted.
- **Attacker.** Any party that can send HTTP to the proxy, can control DNS answers for a
  hostname the seller registered, or can read logs.

## Threats and mitigations

| Threat                                           | Mitigation                                                                                                              | Test                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Path traversal to other upstream paths (B1)      | Upstream URL built from the seller base path only; dot segments, encoded dots, double encoding and backslashes rejected | `url.test.ts`, `flow.test.ts` B1   |
| SSRF to private addresses                        | Static URL rules plus all resolved addresses must be public; connection pinned to the validated address (`upstream.ts`) | `ssrf.test.ts`, `upstream.test.ts` |
| DNS rebinding between check and connect          | One resolution; the TCP connection uses a custom lookup that returns the validated address                              | `upstream.test.ts`                 |
| Replay of a payment                              | Lock keyed on canonical payload hash, TTL 300 s, released when no upstream call happened                                | `flow.test.ts` I3, B3              |
| Double charge on ambiguous settle (B2)           | Settle called once; ambiguous or unreadable settle is terminal and logged                                               | `flow.test.ts` I6, B2              |
| Credential or cookie leak to the upstream        | Request header allowlist (B4)                                                                                           | `guard.test.ts`, `flow.test.ts`    |
| Leak of upstream secrets or cookies to the buyer | Response header allowlist (B6); paid bodies `cache-control: private, no-store`                                          | `flow.test.ts` B6                  |
| Shared-cache leak of a paid body                 | `cache-control: private, no-store` and `vary: payment-signature` on paid 2xx                                            | `flow.test.ts` B6                  |
| Oversized or malformed requests                  | Guard: method, path length, byte cap, content type, JSON depth and keys, NUL bytes (I8)                                 | `guard.test.ts`, `flow.test.ts` I8 |
| Write methods without intent                     | Default `GET` and `HEAD`; `POST`, `PUT`, `PATCH`, `DELETE` need `sideEffectsAcknowledged` (B5)                          | `config.test.ts`                   |
| Redirect to an unvetted host                     | Redirects are never followed; a 3xx is an upstream failure                                                              | `upstream.test.ts`                 |
| Target host leaking to buyer or logs (B8)        | Responses and logs carry no target URL or host                                                                          | `flow.test.ts` B8                  |
| Buyer bypassing the seller's origin              | Origin auth, see below                                                                                                  | `flow.test.ts` B7                  |
| Tampered stored config                           | Config re-validated on every read; invalid config fails closed with 503 (I5)                                            | `flow.test.ts` I5                  |

## Origin bypass

The seller's origin is the last line of defence. If a buyer can reach the origin
directly, the payment check is skipped. Origin auth closes that path only when the
origin is configured to reject calls without the proxy's secret.

### Mitigations in this proxy

- `originAuth.mode: "secret_header"` makes the proxy send a header (default
  `x-payr-origin-key`) that the origin checks. The value comes from an injected
  `OriginAuthenticator`, never from the buyer.
- The origin header is merged after the buyer's allowlisted headers, so a buyer header
  with the same name is overwritten. The flow keeps only the configured header name
  from the authenticator's output.
- If the authenticator is missing, throws, or returns no value for the header, the
  request gets 503 and no upstream call is made (B7).

### What this does not mitigate

- **A leaked origin secret.** Anyone who has the value can call the origin directly.
  Rotation and storage belong to the server (Brief 2b). Rotate the value when a seller
  is removed or a leak is suspected.
- **An origin that does not check the header.** The proxy cannot enforce the seller's
  origin. Seller setup must confirm the check exists.
- **Network-level bypass** (the origin's public address is reachable by any client).
  The seller should restrict the origin to the proxy's egress addresses where it can.

### Lockdown and waiver policy

- `stellar:testnet` may run without origin auth.
- `stellar:pubnet` requires `originAuth.mode` other than `none`. A seller may run
  pubnet without origin auth only with a recorded `lockdownWaiver` (`acceptedAt`,
  `acceptedBy`). The waiver is a deliberate, dated record that the origin is open
  to bypass. Review every waiver when the origin changes.
