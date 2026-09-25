# Vibe Research website

This directory is the source of [viberesearch.wiki](https://viberesearch.wiki), the official Vibe Research website.

- Static HTML, CSS and JavaScript; no build step.
- `index.html` is the page entry point.
- `img/` contains public product screenshots only.
- Cloudflare Pages project: `vibe-research`.

Deploy from the repository root after authenticating Wrangler:

```bash
npx wrangler pages deploy website --project-name vibe-research --branch main
```

Do not add API keys, private reports, holdings, or local user data to this directory.
