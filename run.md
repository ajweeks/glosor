
## Hosting

```sh
npm install
npm run build-corpus                     # optional: needed for passages and for book/TED long sentences (~9 MB download)
```

Grader: Set the grader via e.g., `MODEL=claude-haiku-4-5 npm start`.

```sh
ANTHROPIC_API_KEY=sk-ant-...
TURNSTILE_SITE_KEY=0x...  TURNSTILE_SECRET_KEY=0x...   # Cloudflare Turnstile (free): dash.cloudflare.com → Turnstile → add your hostname
ACCESS_PASSWORD=...                                     # optional: also require a shared password
DAILY_BUDGET_USD=5                                      # stop grading once today's estimated spend (UTC) reaches this
RATE_LIMIT=60                                           # Claude calls per session per hour (default 60)
SESSION_SECRET=$(openssl rand -hex 32)                  # keeps sessions valid across restarts
TRUST_PROXY=1                                           # behind nginx/Caddy: use X-Forwarded-For for the client IP
```

- **Sessions.** Visitors pass the captcha (and password, if set) once and get a signed, `HttpOnly` / `Secure` / `SameSite=Strict` cookie that lasts 12 hours (`SESSION_HOURS`). Every API route needs it; an expired session brings the gate back and resumes where the visitor was. Ten failed sign-ins from one IP lock it out for 15 minutes.
- **Limits.** The captcha only proves a human opened the session. `RATE_LIMIT` bounds one session and `DAILY_BUDGET_USD` bounds everyone together, so that's the number that caps your bill. Spend is counted in memory, so a restart resets the day's total. Also set a monthly spend limit in the Anthropic Console as a backstop.
- **HTTPS.** Serve it behind a TLS-terminating proxy (Caddy does this automatically). The session cookie is `Secure`, so plain http only works on `localhost`, and only in Chrome and Firefox.
- **Headers.** Every response carries a Content-Security-Policy (scripts from this origin and Turnstile only, no framing), `nosniff` and a referrer policy.
