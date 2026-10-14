# KV schema

The proxy uses two KV stores. Each has its own REST endpoint and token.

| Store  | Env (URL / token)                                                                                     | Who writes      | Who reads       |
| ------ | ----------------------------------------------------------------------------------------------------- | --------------- | --------------- |
| CONFIG | `KV_CONFIG_REST_API_URL` / `KV_CONFIG_REST_API_TOKEN` (server) and `KV_CONFIG_READ_ONLY_TOKEN` (Edge) | Server only     | Edge and server |
| STATE  | `KV_STATE_REST_API_URL` / `KV_STATE_REST_API_TOKEN`                                                   | Edge and server | Edge and server |

Edge never holds a token that can write CONFIG. Losing the Edge read-only token
exposes seller configs but not their write path.

## Keys

### `cfg:{id}` (CONFIG store)

A seller's proxy config as JSON. `{id}` matches `^[a-z0-9][a-z0-9-]{2,62}$`.

- Value: JSON that must validate against `ProxyConfigSchema` (`src/proxy/config.ts`).
- Written by the server only, on seller setup and edits.
- Read on every request and validated again on read. A parse failure fails closed
  with 503. The proxy never trusts a stored config.
- No TTL. Deleted by the server when a seller removes an endpoint.

### `lock:{sha256}` (STATE store)

A replay lock for one `PAYMENT-SIGNATURE` value.

- `{sha256}` is the lowercase hex SHA-256 of the raw header string.
- Value: `"1"`.
- Written with `SET NX` and a TTL, so only one request per signature can reach
  the upstream (invariant I3). A duplicate gets 409 and never reaches upstream.
- TTL: 300 seconds. The lock is never released early, even on failure. A
  failed signature is not reusable, so the buyer must sign a fresh one.
- A KV error on this write fails closed with 503 (invariant I4).

### `rl:{scope}:{key}` (STATE store)

Rate counters. Reserved for Brief 2b. The key format is fixed here so that
2b and the dashboard agree on it. `{scope}` is one of `ip`, `seller`, `payto`.
`{key}` is the scoped identifier. Counters use a fixed window with a TTL equal to
the window length. This brief defines no reads or writes for them.

## Size and encoding

- Keys are ASCII. Values are UTF-8 JSON, at most 16 KiB each.
- No key contains a secret or a buyer-supplied value other than the signature hash.
