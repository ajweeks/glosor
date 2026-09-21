# översätt

A minimal Swedish ⇄ English translation game.

- **Sources.** All text is human-translated:
  - **short:** [Tatoeba](https://tatoeba.org) sentences, crowd-written and community-reviewed (CC BY 2.0 FR), fetched live.
  - **long:** longer sentences, split evenly between Tatoeba (12+ words), the book, and TED talks.
  - **passage:** 2–5 consecutive sentences (35–100 words) from the book or a TED talk.
  - Both sides of a pair must end on a sentence-final mark and the Swedish must keep its å/ä/ö. OPUS aligns line for line, but the two languages aren't always split into sentences at the same places, so a Swedish sentence can run past its line and finish inside the next one — the discarded half would otherwise show up as a reference that stops mid-clause (`…, utan också`). A few lines also reached OPUS with their diacritics stripped (`nagot`), which would mark correct spelling as wrong. Together that drops ~4% of the corpus.
  - **The book** is Jerome K. Jerome's *Three Men in a Boat* with its published Swedish translation, via [OPUS Books](https://opus.nlpl.eu/Books.php). **TED talks** are volunteer-translated transcripts from [OPUS TED2020](https://opus.nlpl.eu/TED2020.php). Both are downloaded locally by `npm run build-corpus` and aren't redistributed.
- **Grading.** Answers that match a reference up to case, punctuation, and English contractions (`I've` = `I have`, `didn't` = `did not`, `can't` = `cannot`, `she'd` = `she had/would`, …) are accepted without calling the grader and aren't recorded as mistakes; the words that differ only by contraction are highlighted in yellow. Anything else gets a word diff plus feedback from Claude. **Feedback and mistake explanations are written in Swedish**, in both directions; the mistake keys stay in English kebab-case so they keep grouping across answers.
- **Study lists.** The mistakes tab turns what you haven't reviewed yet into a Swedish vocabulary list. Ranking picks the candidates locally — **most often** (plain count) or **most important** (count × category weight × recency, doubled for anything you got wrong again after reviewing it, weighting idiom and preposition above word order and spelling) — and Claude then keeps only what's worth memorising: uncommon words, words that govern a particular preposition, fixed idioms. Grammar, inflection (`som levts` → `som levs`) and everyday words are dropped. What's kept is written in dictionary form and in Swedish only, whichever direction the mistake was made in: `en likriktning`, `att belasta`, `benägen till`, `kantonesiska` — never definite, plural or inflected. Tick lines to build the copyable list beside it; **apply** marks *every* candidate the list was built from as reviewed, ticked or not, dropped or kept. Reviewed mistakes keep their counts and come back the moment you make them again.
- **Storage.** History and mistakes are saved in the browser's localStorage. Each mistake gets a key such as `gender:ett-hus`. The grader never sees earlier mistakes; the mistakes tab only groups identical keys.
- **Cost.** Every grading call, including regrades, records its input/output tokens and an estimated cost (tokens × list price of the model that served it). The history tab shows the total, the cost per answer, and a per-call breakdown. Study lists are billed the same way: each one shows its own cost, and the history total counts them in (hover it for the split).

```sh
npm install
npm run build-corpus                     # optional: needed for passages and for book/TED long sentences (~9 MB download)
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:5173
```

Grader: Claude Sonnet 5 at medium effort by default. Every graded answer has a small picker under the feedback that regrades it with another model or thinking level: Haiku 4.5, Sonnet 5 (low to xhigh), Opus 5 (medium to xhigh), or Fable 5.1 (medium/high). A regrade replaces that answer's recorded mistakes instead of adding to them. Set the default with environment variables, e.g. `MODEL=claude-opus-5 EFFORT=high npm start`.

Keys: **Enter** submits and then moves to the next sentence · **Shift+Enter** adds a newline · **Esc** skips.
