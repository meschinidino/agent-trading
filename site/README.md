# Onda landing — Cloudflare Pages

Static, dependency-free landing in `site/` (single `index.html` + `assets/`). Deploy as-is.

## Deploy (one human step: the Cloudflare login)

```bash
npx wrangler login            # Dino only — opens browser, his CF account
npx wrangler pages deploy site --project-name onda
```

First deploy creates the `onda` Pages project and prints `https://onda.pages.dev`.
Later deploys reuse it. No build command, no env vars, no secrets.
Config: repo-root `wrangler.toml` (`pages_build_output_dir = "site"`).

Alternative: Pages dashboard → Create → Upload assets → upload the `site/` folder.

All CTAs point to the live app: https://onda.wonderfulsky-b50ff12c.eastus.azurecontainerapps.io/

## Screenshots (language-matched, v0.3.2)

`assets/en/*` and `assets/es/*` are straight captures of the real app
(`apps/web` served locally with the API), one set per landing language; the
EN/ES toggle swaps the images with the copy. Never edit pixels to translate.

- Start/confirm/receipt per language, desktop 1440×900 @2x. Hero uses the
  confirmation-card element capture; steps use the full-app captures.
- App display language: `apps/web/src/i18n.ts` — `?lang=en` (persisted to
  `onda-app-lang`) or the header ES/EN switch. Display strings only; chat
  orders sent to the parser are always composed in es-AR, and the EN UI
  says so. Recapture by running the app + API locally and screenshotting
  `/?lang=en` and `/?lang=es` after register → wallet → deposit → order.
