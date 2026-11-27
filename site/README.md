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
