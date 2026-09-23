# glosor

A minimal Swedish ⇄ English translation game.

- **Sources.** All text is human-translated:
  - **short:** [Tatoeba](https://tatoeba.org) sentences, crowd-written and community-reviewed (CC BY 2.0 FR), fetched live.
  - **long:** longer sentences, split evenly between Tatoeba (12+ words), the book, and TED talks.
  - **passage:** 2–5 consecutive sentences (35–100 words) from the book or a TED talk.
  - Both sides of a pair must end on a sentence-final mark and the Swedish must keep its å/ä/ö. OPUS aligns line for line, but the two languages aren't always split into sentences at the same places, so a Swedish sentence can run past its line and finish inside the next one — the discarded half would otherwise show up as a reference that stops mid-clause (`…, utan också`). A few lines also reached OPUS with their diacritics stripped (`nagot`), which would mark correct spelling as wrong. Together that drops ~4% of the corpus.
  - **The book** is Jerome K. Jerome's *Three Men in a Boat* with its published Swedish translation, via [OPUS Books](https://opus.nlpl.eu/Books.php). **TED talks** are volunteer-translated transcripts from [OPUS TED2020](https://opus.nlpl.eu/TED2020.php). Both are downloaded locally by `npm run build-corpus` and aren't redistributed.
- **Grading.** Answers that match a reference up to case, punctuation, and English contractions (`I've` = `I have`, `didn't` = `did not`, `can't` = `cannot`, `she'd` = `she had/would`, …) are accepted without calling the grader and aren't recorded as mistakes; the words that differ only by contraction are highlighted in yellow. Anything else gets a word diff plus feedback from Claude. **Feedback and mistake explanations are written in Swedish**, in both directions; the mistake keys stay in English kebab-case so they keep grouping across answers.
- **Study lists.** The mistakes tab turns what you haven't reviewed yet into a Swedish vocabulary list. Ranking picks the candidates locally — **most often** (plain count) or **most important** (count × category weight × recency, doubled for anything you got wrong again after reviewing it, weighting idiom and preposition above word order and spelling) — and Claude then keeps only what's worth memorising: uncommon words, words that govern a particular preposition, fixed idioms. Grammar, inflection (`som levts` → `som levs`) and everyday words are dropped. What's kept is written in dictionary form and in Swedish only, whichever direction the mistake was made in: `en likriktning`, `att belasta`, `benägen till`, `kantonesiska` — never definite, plural or inflected. Tick lines to build the copyable list beside it; **apply** marks *every* candidate the list was built from as reviewed, ticked or not, dropped or kept. Reviewed mistakes keep their counts and come back the moment you make them again.
- **Storage.** History and mistakes are saved in the browser's localStorage. Each mistake gets a key such as `gender:ett-hus`. The grader never sees earlier mistakes; the mistakes tab only groups identical keys. To move between browsers, **copy** (on the history or mistakes tab) puts everything on the clipboard as JSON and **merge** adds it on the other side: new answers are added, mistakes are combined without double-counting, and merging the same data twice changes nothing.
- **Cost.** Every grading call, including regrades, records its input/output tokens and an estimated cost (tokens × list price of the model that served it). The history tab shows the total, the cost per answer, and a per-call breakdown. Study lists are billed the same way: each one shows its own cost, and the history total counts them in (hover it for the split).

```sh
npm install
npm run build-corpus                     # optional: needed for passages and for book/TED long sentences (~9 MB download)
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:5173
```

Grader: Claude Sonnet 5 at medium effort by default. Every graded answer has a small picker under the feedback that regrades it with another model or thinking level: Haiku 4.5 or Sonnet 5 (low to high). A regrade replaces that answer's recorded mistakes instead of adding to them. Set the default with environment variables, e.g. `MODEL=claude-haiku-4-5 npm start`.

## Hosting

Run locally it's open, with no captcha, password or limits. Before putting it on the internet, set these, since every grading call is billed to your API key:

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

To test the gate locally, use Cloudflare's always-pass test keys: `TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`.

### Hosting from home

`./start.sh` runs the whole thing with one command. The first run copies `.env.example` to `.env` (gitignored, mode 600) with a fresh `SESSION_SECRET`; fill in the rest and run it again. It refuses to start while a key is missing, installs dependencies and builds the corpus if needed, then starts the server.

To reach it from the internet without opening ports, use a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). It needs a domain on Cloudflare. Once:

```sh
cloudflared tunnel login
cloudflared tunnel create glosor
cloudflared tunnel route dns glosor glosor.yourdomain.com   # also add this hostname to the Turnstile widget
```

Then set `TUNNEL_NAME=glosor` in `.env`, and `./start.sh` runs the tunnel alongside the server and sets `TRUST_PROXY=1` for it.

Keys: **Enter** submits and then moves to the next sentence · **Shift+Enter** adds a newline · **Esc** skips.
