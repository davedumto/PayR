## Summary

<!-- What this PR changes and why, in two or three sentences. -->

## What was built

<!-- Feature or change, and the file map for anything new. -->

| File | Purpose |
| ---- | ------- |
|      |         |

## Decisions this brief did not specify

<!-- Each judgement call you made, with the reason. Write "None" if there were none. -->

-

## Deviations from the brief

<!-- Anything that differs from the brief, and why. Write "None" if there were none. -->

-

## Colour and risk

<!-- Only when colours or risk labels change. Otherwise write "Not applicable". -->

## How to run

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

## Test and CI results

- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm audit --prod --audit-level=high`
- [ ] `pnpm test:e2e` (desktop and mobile)

CI run: <!-- link -->

## Open questions

-

## Security checklist

- [ ] No secrets committed, and `.env.local` is not in the diff
- [ ] No server-only variable is read in client or proxy code
- [ ] No new third-party request in the browser
