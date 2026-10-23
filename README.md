# avto2000-cf — the Avto 2000 site on Cloudflare

WordPress + Elementor stays the editor (`../avto2000-elementor`, http://avto2000-elementor.test).
This repo publishes a static copy to a Cloudflare Worker, and the Worker answers the
Contact Form 7 and Elementor Pro form requests itself, so no PHP runs at Cloudflare.

```
npm run export     # WordPress -> public/ + src/forms.generated.json
npm run dev        # local preview on the real Workers runtime: http://localhost:8787
npm run deploy     # wrangler deploy (needs: npx wrangler login)
npm run publish    # export + deploy
```

| Path | What |
|---|---|
| `scripts/export.mjs` | renders pages from Yoast's sitemap, copies used assets + Elementor's lazy chunks, rewrites URLs |
| `scripts/forms-dump.php` | reads CF7 forms and Elementor form widgets out of WordPress (run by the export) |
| `src/worker.js` | form endpoints, WordPress-compatible JSON: CF7 `/wp-json/contact-form-7/v1/...`, Elementor `/wp-admin/admin-ajax.php` |
| `wrangler.jsonc` | Worker + static assets config; `/wp-json/*` and `/wp-admin/*` hit the Worker first |
| `public/` | generated, do not edit (re-run the export) |

**Mail.** `MAIL_MODE=log` (default) logs each submission to Workers → Logs and reports
success. For real mail set `MAIL_MODE=send` plus either the `send_email` binding
(avto2000.com must be on Cloudflare DNS with Email Routing, recipient verified) or a
`RESEND_API_KEY` secret.

**Never commit `ssh/`** — it holds the cPanel key; `.gitignore` covers it.
