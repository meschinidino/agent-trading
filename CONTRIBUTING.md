# Contributing

Small, reviewable PRs against `main`. This file is the short path; the README's Quickstart gets the app running.

## Before you open a PR

```bash
pnpm install
pnpm build
pnpm test
```

All three must pass. There is no separate lint step today.

## Rules of the house

- **Paper trail in the same PR** (project rule): bump `VERSION` per semver (feature = minor, fix or behavior-changing docs = patch), add a `CHANGELOG.md` entry under the new version with the PR's issue refs (e.g. `refs DIN-28`), and sync every version reference the repo carries (`package.json`, `apps/api/package.json`, `apps/web/package.json`, `apps/api/src/config.ts` `serverVersion`, and the version lines in `README.md` / `README.es.md`). Sync any doc the change makes stale — README EN and ES move together.
- **Specs first for anything money-adjacent.** The confirmation gate, the ledger and the execution-flag behavior are specified in `docs/specs/`; changes there are reviewed before code follows. Product specs and docs under `docs/` are written in Spanish (rioplatense-neutral), technical terms in English.
- **Never commit secrets.** No `.env` files, tokens or keys — `.env.example` documents every variable with demo defaults. Scratch files and keypairs live outside the repo.
- **No PR merges without the project owner's explicit word** on that PR. No auto-merge, no `--delete-branch`.
- Keep the diff honest: only claim commands and behaviors you actually ran.
