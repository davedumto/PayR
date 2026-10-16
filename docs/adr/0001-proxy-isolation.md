# ADR 0001: Proxy isolation and the request budget

Status: Accepted (2026-10-16)

## Context

The paywall proxy holds two KV stores: CONFIG (seller configs) and STATE (replay
locks and rate counters). Each store has its own REST URL and tokens. CONFIG
has a read-only token for the proxy and a read-write token for the server. The
proxy never sees the write token.

Each token is set as an environment variable. Everything in one Vercel project
shares those variables, so code in that project can read every token.

## Decision

1. The two-KV design is **defense in depth within one deployment, not isolation.**
   It limits what a bug in proxy request handling can do: such a bug can read
   configs but cannot write them, and it cannot touch the server-only token. It
   does not protect the proxy from a compromise of the deployment itself,
   because one project shares environment variables across its functions.
2. The proxy modules run on the Node runtime only. `src/env.proxy.ts` is the
   list of variables the proxy request handler may read. `src/env.server.ts`
   is the server list. A test fails if any proxy module imports the server
   env, directly or through any import chain.
3. **Upgrade path.** Move the proxy into its own Vercel project with its own
   environment scope. That project receives only the read-only CONFIG token and
   the STATE token. The server-only write token stays in the dashboard project.
   This makes the split a real isolation boundary.

## Consequences

- Until the upgrade, a compromise of the deployment exposes every token in it.
  Keep the server-only write token out of any function that handles requests
  where possible.
- The env boundary tests and the transitive import guard enforce the code-level
  split. They do not replace the deployment-level split.

## Request budget

A paid request runs these stages in sequence. Each has a timeout.

| Stage                 | Timeout             | Default | Maximum |
| --------------------- | ------------------- | ------- | ------- |
| Config read and guard | (none, KV call)     |         |         |
| verify                | `verifyTimeoutMs`   | 5 s     | 15 s    |
| upstream              | `upstreamTimeoutMs` | 10 s    | 30 s    |
| settle                | `settleTimeoutMs`   | 45 s    | 60 s    |

The facilitator retries twice, each attempt up to 6 seconds, before it answers
a settle request. A 45-second default leaves room for that, plus network
latency.

Worst case per request is about 106 seconds: 15 + 30 + 60, plus about 1 second
for everything else. The serving function therefore needs a **maximum duration
of at least 120 seconds**. The replay lock TTL is 300 seconds, which is longer
than the worst case, so a legitimate signature cannot be replayed while its
first request is still running.

A client-side settle timeout is **ambiguous, not "nothing spent"**. The
facilitator may already have submitted the transaction. The flow treats it as
`terminal_charged` with no retry, and it logs the event.
