# actwhy web playground

Static, 100% client-side landing page + playground: paste GitHub Actions workflow YAML, simulate a push/PR, and see which workflows fire (and why the rest don't). It bundles the real `src/core` engine — the same logic as the CLI.

Build: `npm run build:web` (runs `node web/build.mjs`, emitting `web/dist/`). Bundles `web/src/main.ts` → `web/dist/app.js` and copies the static assets; the page loads with zero external requests.

Deploys to https://actwhy.vercel.app (serve `web/dist` as the static root).
