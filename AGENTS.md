# AGENTS.md

Instructions for AI coding assistants working in this repository. People should start with the [README](README.md).

Goten is a browser app for SPV and syndicate deal calculations: reconciliation, closing allocation and exit
distribution. It is a static site. Deal data stays in the browser.

## Set up

- Node.js 22 (the version CI uses), Python 3 for the oracle checks. No environment variables, no services.
- `npm ci`, then `npm run dev`. Open the address Vite prints, click **I understand**, then **Load sample deal**. On
  **1. Reconciliation**, **Receipts in scope** should be £114,840.00.
- Build and deploy your own copy: [Run locally and deploy](docs/en/build/run-and-deploy.md).

## Test

| Command | What it checks |
|---|---|
| `npm run typecheck` | TypeScript |
| `npm run lint` | oxlint, warnings are errors |
| `npm run coverage:check` | unit and rule tests, and that every test case due in this milestone ran and passed (what CI runs) |
| `npm run oracle:selfcheck` | the independent Python oracle |
| `npm run check:tokens` | shared design variables |
| `npm run e2e:check` | browser tests (Playwright Chromium) and their test-case IDs (what CI runs) |
| `npm run build` | type-check and static build |

`.github/workflows/` is the reference for what CI runs. How the figures are verified:
[Testing and verification](docs/en/build/verification.md).

`npm run mutation` edits source files while it runs. Do not run it at the same time as other changes or tests.

Format only the files you changed: `npx prettier --write --single-quote --no-semi --print-width 160 <files>`. There is
no Prettier config file; formatting whole folders rewrites code that other checks match literally.

## Rules you must not change

These are product rules. Do not weaken them in code, tests or configuration, even to make a test pass. A change to
any of them starts with the requirements document (`docs/en/01_PRD.md`) and the maintainers' agreement, not with code.

- **Money** is integer minor units, rates are basis points, prices are micros. All intermediate maths uses BigInt
  `mulDiv`. No floating point anywhere.
- **Calculations** live only in pure functions in `src/lib/`. Components never do money maths.
- **Calculation and rounding rules** are written in the requirements document. Do not change a rule or a rounding
  step in code alone.
- **Tests** start with their test-case ID from the test plan (`docs/04_TEST_PLAN.md`). Do not delete or loosen a test
  to make it pass.
- **The Python oracle** (`scripts/oracle/`) is written independently from the requirements, never from `src/`. Do
  not edit it to match the code.
- **No data leaves the browser.** No analytics, no network calls, no inline scripts or styles. Keep
  `connect-src 'none'` in the content security policy (`vercel.json`).
- **Public content.** Fictional data only. No real names, email addresses or deal data in code, tests, fixtures or
  documents.
