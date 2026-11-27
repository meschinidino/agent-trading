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

- Demo set per language (DIN-24): `step1-ask` (chat with the Spanish order),
  `step2-quote` (swap panels with the live Jupiter implied price),
  `step3-confirm` (confirmation card), `step4-slide` (knob mid-gesture),
  `step5-receipt` (executed receipt). The landing's guided demo steps through
  these real captures (click / Prev-Next / Play); the hero reuses
  `step3-confirm`. Never pixel-edit a capture; framing crops of full-page
  renders are the only allowed transform.
- App display language: `apps/web/src/i18n.ts` — `?lang=en` (persisted to
  `onda-app-lang`) or the header ES/EN switch. Display strings only; chat
  orders sent to the parser are always composed in es-AR, and the EN UI
  says so. Recapture by running the app + API locally and screenshotting
  `/?lang=en` and `/?lang=es` after register → wallet → deposit → order,
  freezing the slide knob mid-drag for step 4 before completing the gesture.
