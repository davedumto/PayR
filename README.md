# PayR (Sylox)

A one-click x402 paywall for APIs, built on Vellar (Stellar x402 facilitator).
The UI brand is **Sylox**.

This repository currently contains the **foundation scaffold**: the app shell,
the Sylox design tokens, the dashboard placeholder routes and the environment
contract. There is no proxy, no Claude call, no KV access and no auth yet.

## Requirements

- Node 24 LTS (see `.nvmrc`; `engines` requires `>=24 <25`)
- pnpm 10.28.0 (pinned by `packageManager`)

## Setup

```bash
pnpm install
cp .env.example .env.local   # then fill in the values
pnpm dev                     # http://localhost:3000 redirects to /dashboard
```

The app refuses to start if a required variable is missing or malformed. The
error names the variable and never prints its value.

## Scripts

| Command             | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `pnpm dev`          | Next.js dev server                                |
| `pnpm build`        | Production build (validates configuration)        |
| `pnpm start`        | Serve the production build on port 3000           |
| `pnpm lint`         | ESLint (Next.js, TypeScript, Prettier-compatible) |
| `pnpm format:check` | Prettier check                                    |
| `pnpm typecheck`    | `tsc --noEmit` with strict mode                   |
| `pnpm test`         | Vitest unit tests (`src/**/*.test.ts`)            |
| `pnpm test:e2e`     | Playwright smoke tests (needs a built app)        |

For the smoke tests on a machine with a preinstalled Chromium, set
`PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`. Otherwise run
`pnpm exec playwright install chromium` once.

## Layout

```
src/
  app/                 App Router: root layout, fonts, dashboard routes
  components/
    shell/             AppShell, sidebar nav, mobile drawer, testnet notice
    ui/                Button, Card, Badge, EmptyState, PageHeader
  lib/nav.ts           Navigation items and active-route matching
  styles/tokens.css    Sylox colour and type tokens (the only colour source)
  styles/globals.css   Base styles, focus ring, reduced motion
  env.ts               Zod-validated environment contract
  instrumentation.ts   Validates the environment at server start
fonts/                 Self-hosted Inter, Space Mono, Big Shoulders Display
e2e/                   Playwright smoke tests
```

## Configuration

Every variable is documented in `.env.example`. Server secrets must never carry
the `NEXT_PUBLIC_` prefix. Only `NEXT_PUBLIC_VELLAR_NETWORK` is public, and it is
read at build time, so rebuild after changing it.

## Design tokens

Colours and type are defined once, in `src/styles/tokens.css`, and exposed to
Tailwind through `@theme`. Dark is the only theme. Do not add colours outside
that file without sign-off.
