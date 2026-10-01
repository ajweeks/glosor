import { norm, closestReference } from "./text.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------------------
// Local storage

const KEYS = {
  history: "glosor.history",
  mistakes: "glosor.mistakes",
  studylog: "glosor.studylog",
  dir: "glosor.dir",
  length: "glosor.length",
  session: "glosor.session",
};

// The app used to be called översätt; carry its saved data over to the new keys once.
try {
  for (const key of Object.values(KEYS)) {
    const legacy = key.replace(/^glosor\./, "oversatt.");
    const value = localStorage.getItem(legacy);
    if (value !== null && localStorage.getItem(key) === null) localStorage.setItem(key, value);
    localStorage.removeItem(legacy);
  }
} catch {}

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Could not save", key, e);
  }
}

let history = load(KEYS.history, []); // newest first
let mistakes = load(KEYS.mistakes, {}); // key -> { key, category, count, examples[], reviewedAt? }
let studyLog = load(KEYS.studylog, []); // study-list calls, newest first, for cost tracking

// Records mistakes from a graded entry, and returns how many times each was seen *before* this one.
function recordMistakes(entry) {
  const priorCounts = {};
  const counted = new Set();
  for (const m of entry.result?.mistakes ?? []) {
    m.key = normalizeKey(m.key) || `${m.category}:${norm(m.wrong)}`;
    const existing = mistakes[m.key] ?? findSameFix(m);
    if (existing) m.key = existing.key; // may have matched by identical fix under another key
    // The same mistake listed twice in one answer counts once.
    if (counted.has(m.key)) continue;
    counted.add(m.key);
    priorCounts[m.key] = existing?.count ?? 0;
    const rec = existing ?? (mistakes[m.key] = { key: m.key, category: m.category, count: 0, examples: [] });
    rec.count++;
    rec.lastSeen = entry.ts;
    rec.examples.unshift({ wrong: m.wrong, right: m.right, explanation: m.explanation, entryId: entry.id, ts: entry.ts });
    rec.examples = rec.examples.slice(0, 12);
  }
  save(KEYS.mistakes, mistakes);
  return priorCounts;
}

// Undoes recordMistakes for an entry, so regrading it doesn't double-count.
function unrecordMistakes(entry) {
  for (const key of new Set((entry.result?.mistakes ?? []).map((m) => m.key))) {
    const rec = mistakes[key];
    if (!rec) continue;
    rec.count--;
    rec.examples = rec.examples.filter((e) => e.entryId !== entry.id);
    if (rec.count <= 0) delete mistakes[key];
  }
  save(KEYS.mistakes, mistakes);
}

// Fallback repeat detection: the exact same wrong→right fix in the same category ("gender:…"),
// even if the model picked a different key. One fragment can hold several different mistakes,
// so the category has to agree too.
const keyCategory = (key) => key.split(":")[0];
function findSameFix(m) {
  const w = norm(m.wrong), r = norm(m.right);
  if (!w) return null;
  return Object.values(mistakes).find(
    (rec) => keyCategory(rec.key) === keyCategory(m.key) && rec.examples.some((e) => norm(e.wrong) === w && norm(e.right) === r)
  );
}

const normalizeKey = (k) => String(k ?? "").trim().toLowerCase().replace(/\s+/g, "-");

// ---------------------------------------------------------------------------
// Diff view

function renderDiff(entry) {
  const refs = entry.references;
  const best = closestReference(entry.attempt, refs);
  const others = refs.filter((r) => r !== best.ref && r.text !== best.ref.text);
  const othersHtml = others.length
    ? `<div class="others">${others.map((r) => `<div>${esc(r.text)}</div>`).join("")}</div>`
    : "";

  // Top line: the attempt, with divergent words struck. Bottom line: the reference, with missing words highlighted.
  // Words that only differ by contraction are marked in yellow on both lines.
  const mark = (tag) => (t) =>
    t.state === "same" ? esc(t.text) : t.state === "equiv" ? `<mark>${esc(t.text)}</mark>` : `<${tag}>${esc(t.text)}</${tag}>`;
  const rows = `<div class="diff">
      <div class="diff-row"><span class="diff-label">yours</span><span>${best.yours.map(mark("del")).join(" ")}</span></div>
      <div class="diff-row"><span class="diff-label">reference</span><span>${best.theirs.map(mark("ins")).join(" ")}</span></div>
    </div>`;

  if (best.exact) {
    return `<div class="match">✓ Matches the reference: <span style="font-family:var(--serif)">${esc(best.ref.text)}</span></div>${othersHtml}`;
  }
  if (best.equivalent) {
    return `<div class="match">✓ Matches the reference, <span class="equiv-note">apart from contractions</span></div>${rows}${othersHtml}`;
  }
  return rows + othersHtml;
}

const VERDICT = { correct: "correct", acceptable: "acceptable", minor_errors: "minor errors", major_errors: "major errors" };

function renderBubble(entry, priorCounts) {
  if (entry.status === "pending") return `<div class="bubble pending">Reading your translation</div>`;
  if (entry.status === "error")
    return `<div class="bubble error">${esc(entry.error)}${entry.id === current?.entry?.id ? `<button class="retry" data-retry>retry</button>` : ""}</div>`;
  const r = entry.result;
  if (!r) return "";
  const counts = priorCounts ?? entry.priorCounts ?? {};
  const list = r.mistakes.length
    ? `<ul class="mistakes-list">${r.mistakes
        .map((m) => {
          const seen = counts[m.key] ?? 0;
          const flag = seen > 0 ? `<span class="repeat" title="You've made this mistake before">repeat · ${seen + 1}×</span>` : "";
          return `<li>
            <div class="fix"><s>${esc(m.wrong)}</s> → <span>${esc(m.right)}</span>${flag}</div>
            <div class="why">${esc(m.explanation)}</div>
            <div class="key">${esc(m.key)}</div>
          </li>`;
        })
        .join("")}</ul>`
    : "";
  return `<div class="bubble">
      <span class="score"><b>${r.score}</b> · ${VERDICT[r.verdict] ?? esc(r.verdict)}</span>
      <p>${esc(r.feedback)}</p>
      ${list}
      ${entry.notice ? `<div class="notice">${esc(entry.notice)}</div>` : ""}
      ${graderPicker(entry)}
    </div>`;
}

// ---------------------------------------------------------------------------
// Access gate: a captcha and/or password, when the server is hosted with one.

let accessCfg = null; // { gated, captcha: siteKey | null, password, authed }
let gating = null; // resolves once the visitor is through; set while the gate is showing
// The session token, sent as a header too: some browsers (DuckDuckGo on mobile) don't send the cookie back.
let sessionToken = load(KEYS.session, null);

// JSON fetch that sends the session and throws the server's error message. A 401 means the session is
// gone (expired, or the server restarted): bring the gate back, then carry on where the visitor was.
async function api(url, opts = {}) {
  const headers = { ...opts.headers, ...(sessionToken && { Authorization: `Bearer ${sessionToken}` }) };
  const res = await fetch(url, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.auth) showGate().then(resume);
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
const postJson = (url, data) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

let turnstileScript = null;
const loadTurnstile = () =>
  (turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = resolve;
    s.onerror = () => {
      turnstileScript = null;
      reject(new Error("Couldn't load the captcha. Refresh to try again."));
    };
    document.head.append(s);
  }));

function showPassword(on) {
  $("#gate-password").type = on ? "text" : "password";
  $("#gate-show").textContent = on ? "hide" : "show";
  $("#gate-show").setAttribute("aria-pressed", on);
}
$("#gate-show").addEventListener("click", () => {
  showPassword($("#gate-password").type === "password");
  $("#gate-password").focus();
});

function showGate() {
  if (!accessCfg?.gated) return Promise.resolve();
  gating ??= new Promise((resolve) => {
    const gate = $("#gate");
    const form = $("#gate-form");
    const pw = $("#gate-password");
    const btn = $("#gate-submit");
    const err = $("#gate-error");
    let token = null;
    let widget = null;
    let failed = false;
    const ready = () => (btn.disabled = !!accessCfg.captcha && !token);

    for (const id of ["play", "history", "mistakes"]) $(`#${id}`).hidden = true;
    $("nav").hidden = $(".brand").hidden = true;
    gate.hidden = false;
    $("#gate-pw").hidden = !accessCfg.password;
    pw.value = "";
    showPassword(false);
    err.textContent = "";
    ready();
    if (accessCfg.password) pw.focus();

    if (accessCfg.captcha) {
      loadTurnstile()
        .then(() => {
          widget = turnstile.render("#gate-captcha", {
            sitekey: accessCfg.captcha,
            theme: "dark",
            callback: (t) => {
              token = t;
              ready();
              // Captcha only: nothing else to fill in. After a failure, wait for a click instead of looping.
              if (!accessCfg.password && !failed) form.requestSubmit();
            },
            "expired-callback": () => ((token = null), ready()),
            "error-callback": () => void (err.textContent = "The captcha couldn't verify this browser. Refresh to try again."),
          });
        })
        .catch((e) => (err.textContent = e.message));
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.textContent = "";
      try {
        const out = await postJson("/api/session", { captcha: token, password: pw.value });
        sessionToken = out.token ?? null;
        save(KEYS.session, sessionToken);
        if (widget !== null) turnstile.remove(widget);
        gate.hidden = true;
        $("nav").hidden = $(".brand").hidden = false;
        gating = null;
        resolve();
      } catch (e) {
        failed = true;
        err.textContent = e.message;
        // Turnstile tokens are single-use: get a fresh one for the next try.
        if (widget !== null) {
          token = null;
          turnstile.reset(widget);
        }
        ready();
      }
    };
  });
  return gating;
}

// Back to whatever the gate interrupted.
function resume() {
  route();
  if (!current) nextRound();
}

// ---------------------------------------------------------------------------
// Grader picker: regrade an answer with a different model / thinking level.

const MODEL_NAMES = {
  "claude-haiku-4-5": "haiku 4.5",
  "claude-sonnet-5": "sonnet 5",
  "claude-opus-5": "opus 5",
  "claude-fable-5-1": "fable 5.1",
};
let graders = null; // { models: { id: [effort|null] }, default: { model, effort } }
fetch("/api/graders")
  .then((r) => r.json())
  .then((g) => (graders = g))
  .catch(() => {});

const graderValue = (g) => `${g.model}|${g.effort ?? ""}`;
const graderLabel = (g) => `${MODEL_NAMES[g.model] ?? g.model}${g.effort ? ` · ${g.effort}` : ""}`;

function graderPicker(entry) {
  if (!graders || !entry.result || entry.result.auto) return "";
  const used = entry.result.grader; // absent on entries graded before the picker existed
  const options = Object.entries(graders.models).flatMap(([model, efforts]) =>
    efforts.map((effort) => {
      const g = { model, effort };
      const selected = used && graderValue(g) === graderValue(used) ? " selected" : "";
      return `<option value="${graderValue(g)}"${selected}>${esc(graderLabel(g))}</option>`;
    })
  );
  const placeholder = used ? "" : `<option selected disabled>regrade with…</option>`;
  return `<div class="grader"><select data-regrade="${entry.id}" title="Regrade with another model">${placeholder}${options.join("")}</select></div>`;
}

document.addEventListener("change", (e) => {
  const id = e.target.dataset?.regrade;
  if (!id) return;
  const entry = current?.entry?.id === id ? current.entry : history.find((h) => h.id === id);
  const [model, effort] = e.target.value.split("|");
  if (entry) gradeEntry(entry, { model, effort: effort || null });
});

// ---------------------------------------------------------------------------
// Game

const DIRS = [
  { id: "swe", label: "sv → en" },
  { id: "eng", label: "en → sv" },
  { id: "mix", label: "mixed" },
];
const LENGTHS = [
  { id: "short", label: "short" },
  { id: "long", label: "long" },
  { id: "passage", label: "passage" },
];
let dir = load(KEYS.dir, "mix");
let length = load(KEYS.length, "short");
if (!LENGTHS.some((l) => l.id === length)) length = "short";
let current = null; // { sentence, entry?, revealed? }
let prefetched = {};
let round = 0; // bumped per nextRound, so a slower earlier load can't overwrite a newer one

const els = {
  source: $("#source"),
  answer: $("#answer"),
  link: $("#srclink"),
  result: $("#result"),
  hint: $("#hint"),
  dir: $("#dir"),
  length: $("#length"),
};

function renderToggles() {
  els.dir.textContent = DIRS.find((d) => d.id === dir).label;
  els.length.textContent = LENGTHS.find((l) => l.id === length).label;
}

function cycle(list, value) {
  return list[(list.findIndex((x) => x.id === value) + 1) % list.length].id;
}

function settingsChanged() {
  save(KEYS.dir, dir);
  save(KEYS.length, length);
  renderToggles();
  prefetched = {};
  if (!current?.entry && !current?.revealed && !els.answer.value.trim()) nextRound();
}

els.dir.addEventListener("click", () => {
  dir = cycle(DIRS, dir);
  settingsChanged();
});
els.length.addEventListener("click", () => {
  length = cycle(LENGTHS, length);
  settingsChanged();
});

const pickFrom = () => (dir === "mix" ? (Math.random() < 0.5 ? "swe" : "eng") : dir);

const fetchSentence = (from) => api(`/api/sentence?from=${from}&length=${length}`);

function prefetch() {
  const from = pickFrom();
  prefetched = { from, promise: fetchSentence(from).catch(() => null) };
}

async function nextRound() {
  const thisRound = ++round;
  current = null;
  els.result.innerHTML = "";
  els.answer.value = "";
  els.answer.disabled = true;
  els.link.textContent = "";
  els.source.textContent = "…";
  els.source.classList.add("loading");
  els.hint.innerHTML = "";

  let sentence = null;
  try {
    if (prefetched.promise) sentence = await prefetched.promise;
    if (!sentence || (dir !== "mix" && sentence.from !== dir) || sentence.length !== length) sentence = await fetchSentence(pickFrom());
  } catch (e) {
    if (thisRound !== round) return;
    els.source.textContent = `Couldn't load a sentence (${e.message}).`;
    els.hint.innerHTML = `<button class="hint-btn" data-next>try again</button><span class="keys"> <kbd>Enter</kbd></span>`;
    els.answer.disabled = false;
    return;
  }
  if (thisRound !== round) return;
  prefetch();

  current = { sentence };
  els.source.classList.remove("loading");
  els.source.textContent = sentence.text;
  els.source.classList.toggle("long", sentence.text.length > 140);
  els.source.lang = sentence.from === "swe" ? "sv" : "en";
  els.answer.lang = sentence.to === "swe" ? "sv" : "en";
  els.answer.placeholder = sentence.to === "swe" ? "Skriv på svenska…" : "Write in English…";
  els.link.href = sentence.source.url;
  els.link.textContent = `${sentence.source.label} ↗`;
  els.link.title = `${sentence.source.title} · ${sentence.source.license}`;
  autosize();
  els.answer.disabled = false;
  els.answer.focus();
  els.hint.innerHTML =
    `<span class="keys"><kbd>Esc</kbd> </span><button class="hint-btn" data-skip>skip</button> ` +
    `<button class="hint-btn" data-submit disabled>submit</button><span class="keys"> <kbd>Enter</kbd></span>`;
}

// Skipping shows the reference translation and closes the round to answers; the next press moves on.
function skip() {
  if (!current || current.entry || current.revealed) return nextRound();
  current.revealed = true;
  els.answer.disabled = true;
  els.result.innerHTML = renderReveal(current.sentence);
  els.hint.innerHTML = `<button class="hint-btn" data-next>next</button><span class="keys"> <kbd>Enter</kbd></span>`;
}

function renderReveal(sentence) {
  const [first, ...rest] = sentence.references;
  const lang = sentence.to === "swe" ? "sv" : "en";
  const others = rest.length ? `<div class="others" lang="${lang}">${rest.map((r) => `<div>${esc(r.text)}</div>`).join("")}</div>` : "";
  return `<div class="diff reveal">
      <div class="diff-row"><span class="diff-label">translation</span><span lang="${lang}">${esc(first?.text ?? "")}</span></div>
    </div>${others}`;
}

async function submit() {
  const attempt = els.answer.value.trim();
  if (!current || current.entry || current.revealed || !attempt) return;
  const s = current.sentence;
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: s.from,
    to: s.to,
    source: s.text,
    length: s.length,
    sourceInfo: s.source,
    references: s.references,
    attempt,
  };
  current.entry = entry;
  els.answer.disabled = true;
  syncSubmit();

  const best = closestReference(attempt, s.references);
  // Identical to a reference, up to case, punctuation and contractions: no need to ask the grader.
  if (best.equivalent) {
    entry.result = { score: 100, verdict: "correct", feedback: "Helt rätt — det här stämmer med referensöversättningen.", mistakes: [], auto: true };
    entry.status = "done";
    entry.priorCounts = {};
    finish(entry);
    return;
  }

  // Otherwise show the diff, and only ask the grader if the user wants feedback: small slips are clear enough from the diff.
  entry.status = "ungraded";
  renderResult(entry);
  els.hint.innerHTML =
    `<span class="keys"><kbd>F</kbd> </span><button class="hint-btn" data-feedback>feedback</button> ` +
    `<button class="hint-btn" data-next>next</button><span class="keys"> <kbd>Enter</kbd></span>`;
}

function requestFeedback() {
  const entry = current?.entry;
  if (entry?.status !== "ungraded") return;
  els.hint.innerHTML = "";
  gradeEntry(entry);
}

async function gradeEntry(entry, grader) {
  const previous = entry.status === "done" ? entry.result : null;
  entry.status = "pending";
  entry.notice = null;
  rerender(entry);
  try {
    const body = await postJson("/api/grade", {
      from: entry.from,
      to: entry.to,
      source: entry.source,
      references: entry.references.map((r) => r.text),
      sourceKind: entry.sourceInfo?.kind,
      attempt: entry.attempt,
      grader,
    });
    if (previous) unrecordMistakes(entry);
    // Every grading call is kept for cost tracking, including regrades that replaced the shown result.
    entry.gradings = [...(entry.gradings ?? []), { ts: Date.now(), ...body.grader, ...body.usage }];
    entry.result = body;
    entry.status = "done";
    entry.priorCounts = recordMistakes(entry);
  } catch (e) {
    if (previous) {
      // Keep the earlier grade when a regrade fails.
      entry.result = previous;
      entry.status = "done";
      entry.notice = `Regrading failed: ${e.message}`;
    } else {
      entry.status = "error";
      entry.error = `Grading failed: ${e.message}`;
    }
  }
  if (entry === current?.entry) finish(entry);
  else {
    save(KEYS.history, history);
    rerender(entry);
  }
}

// Re-renders an entry wherever it's on screen: the current round and/or its history row.
function rerender(entry) {
  if (entry === current?.entry) renderResult(entry);
  const row = document.querySelector(`#history details[data-id="${entry.id}"][data-rendered]`);
  if (row) row.querySelector(".body").innerHTML = renderHistoryBody(entry);
}

function finish(entry) {
  if (entry.status === "done") {
    history = [entry, ...history.filter((h) => h.id !== entry.id)];
    save(KEYS.history, history);
  }
  renderResult(entry);
  els.hint.innerHTML = `<button class="hint-btn" data-next>next</button><span class="keys"> <kbd>Enter</kbd></span>`;
}

function renderResult(entry) {
  els.result.innerHTML = renderDiff(entry) + renderBubble(entry);
  els.result.querySelector("[data-retry]")?.addEventListener("click", () => gradeEntry(entry));
}

function autosize() {
  els.answer.style.height = "auto";
  els.answer.style.height = `${els.answer.scrollHeight + 2}px`;
}
// The submit button is live only while there's an answer to send.
function syncSubmit() {
  const btn = els.hint.querySelector("[data-submit]");
  if (btn) btn.disabled = els.answer.disabled || !els.answer.value.trim();
}
els.answer.addEventListener("input", () => (autosize(), syncSubmit()));

els.answer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape") {
    skip();
  }
});

// Tappable twins of Enter / Esc, for touch screens without those keys. Keeping the answer box focused
// stops a phone from closing its keyboard mid-tap, which shifts the layout and drops the click.
els.hint.addEventListener("mousedown", (e) => {
  if (e.target.closest(".hint-btn")) e.preventDefault();
});
els.hint.addEventListener("click", (e) => {
  if (e.target.closest("[data-next]")) nextRound();
  else if (e.target.closest("[data-skip]")) skip();
  else if (e.target.closest("[data-submit]")) submit();
  else if (e.target.closest("[data-feedback]")) requestFeedback();
});

document.addEventListener("keydown", (e) => {
  if (gating) return;
  if (location.hash.startsWith("#/history") || location.hash.startsWith("#/mistakes")) return;
  if (e.target === els.answer || e.target.tagName === "SELECT") return;
  const status = current?.entry?.status;
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey && status === "ungraded") {
    e.preventDefault();
    return requestFeedback();
  }
  const over = !current || current.revealed || status === "done" || status === "error" || status === "ungraded";
  if ((e.key === "Enter" || (e.key === "Escape" && current?.revealed)) && over) {
    e.preventDefault();
    nextRound();
  }
});

// ---------------------------------------------------------------------------
// History & mistakes views

const fmtDate = (ts) => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

function sourceLink(h) {
  // Entries saved before sources other than Tatoeba existed have flat fields.
  const src = h.sourceInfo ?? { label: `tatoeba #${h.sourceId}`, url: h.sourceUrl, title: `by ${h.owner}` };
  return `<a href="${esc(src.url)}" target="_blank" rel="noopener" title="${esc(src.title)}">${esc(src.label)}</a>`;
}

const entryCost = (h) => (h.gradings ?? []).reduce((sum, g) => sum + (g.cost ?? 0), 0);
const fmtCost = (usd) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function renderGradings(h) {
  if (!h.gradings?.length) return "";
  return h.gradings
    .map((g) => `<div>${esc(graderLabel(g))}${g.servedBy && g.servedBy !== g.model ? ` (served by ${esc(g.servedBy)})` : ""} ·
      ${fmtTokens(g.input)} in / ${fmtTokens(g.output)} out · ${g.cost == null ? "unknown price" : fmtCost(g.cost)}</div>`)
    .join("");
}

function renderHistoryBody(h) {
  return `${renderDiff(h)}${renderBubble(h)}
    <div class="meta">${h.from === "swe" ? "sv → en" : "en → sv"} · ${new Date(h.ts).toLocaleString()} · ${sourceLink(h)}</div>
    <div class="meta cost">${renderGradings(h)}</div>`;
}

function renderHistory() {
  const el = $("#history");
  if (!history.length) {
    el.innerHTML = `<h2><span>history</span><span class="h2-actions">${dataActions()}</span></h2><p class="empty">Nothing yet.</p>`;
    wireData(el);
    return;
  }
  const avg = Math.round(history.reduce((s, h) => s + (h.result?.score ?? 0), 0) / history.length);
  const graded = history.reduce((s, h) => s + entryCost(h), 0);
  const calls = history.reduce((s, h) => s + (h.gradings?.length ?? 0), 0);
  // Study lists are billed too, and survive clearing the history, so they're counted separately.
  const studied = studyLog.reduce((s, c) => s + (c.cost ?? 0), 0);
  const tip = `${calls} grading call${calls === 1 ? "" : "s"} ${fmtCost(graded)}${studyLog.length ? ` · ${studyLog.length} study list${studyLog.length === 1 ? "" : "s"} ${fmtCost(studied)}` : ""} — estimated from token usage × list price`;
  el.innerHTML = `<h2><span>history · ${history.length} · avg ${avg} · <span title="${esc(tip)}">${fmtCost(graded + studied)} spent</span></span><span class="h2-actions">${dataActions()}<button class="clear" data-clear>clear</button></span></h2>
    ${history
      .map((h) => {
        const sc = h.result?.score ?? 0;
        return `<details class="entry" data-id="${h.id}">
          <summary>
            <span class="when">${fmtDate(h.ts)}</span>
            <span class="txt">${esc(h.source)}</span>
            <span class="cost">${h.gradings?.length ? fmtCost(entryCost(h)) : ""}</span>
            <span class="sc ${sc >= 90 ? "good" : sc < 60 ? "bad" : ""}">${sc}</span>
          </summary>
          <div class="body"></div>
        </details>`;
      })
      .join("")}`;

  el.querySelectorAll("details.entry").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (!d.open || d.dataset.rendered) return;
      const h = history.find((x) => x.id === d.dataset.id);
      d.querySelector(".body").innerHTML = renderHistoryBody(h);
      d.dataset.rendered = "1";
    })
  );
  wireData(el);
  el.querySelector("[data-clear]").addEventListener("click", () => {
    if (!confirm("Delete all history? Mistake tracking is kept.")) return;
    history = [];
    save(KEYS.history, history);
    renderHistory();
  });
}

// ---------------------------------------------------------------------------
// Study list: recorded mistakes → a Swedish vocabulary list, written by Claude.
//
// Ranking picks the candidates locally; Claude then throws out the grammar and the everyday words
// and rewrites what's left in dictionary form. Applying a list marks every candidate it was built
// from as reviewed — the kept ones and the discarded ones alike — so the next list starts fresh.
// Nothing is ever deleted: counts keep accumulating, and a mistake made again comes back.

const pendingReview = (m) => !m.reviewedAt || (m.lastSeen ?? 0) > m.reviewedAt;
const missedAfterReview = (m) => m.reviewedAt > 0 && (m.lastSeen ?? 0) > m.reviewedAt;

// "Most important" weighs the category as well as the count: a word that governs its own
// preposition is worth more than a stray comma. Unlisted categories weigh 1.
const CATEGORY_WEIGHT = {
  idiom: 1.6, vocab: 1.5, preposition: 1.5, particle: 1.4, collocation: 1.4, register: 1.1,
  gender: 0.9, definiteness: 0.7, article: 0.7, tense: 0.6, agreement: 0.6, "word-order": 0.5,
  syntax: 0.5, pronoun: 0.5, spelling: 0.4, punctuation: 0.2,
};
function categoryWeight(m) {
  const c = normalizeKey(keyCategory(m.key) || m.category);
  return CATEGORY_WEIGHT[c] ?? CATEGORY_WEIGHT[c.split("-")[0]] ?? 1;
}

// Recent mistakes matter more, but an old repeat still counts: halves monthly, floored at 0.5.
function recencyWeight(m) {
  const days = Math.max(0, (Date.now() - (m.lastSeen ?? 0)) / 86400000);
  return 0.5 + 0.5 * 0.5 ** (days / 30);
}

// Made again after you said you'd reviewed it: the strongest signal there is.
const importance = (m) => m.count * categoryWeight(m) * recencyWeight(m) * (missedAfterReview(m) ? 2 : 1);

const RANKERS = {
  frequent: { label: "most often", sort: (a, b) => b.count - a.count || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) },
  important: { label: "most important", sort: (a, b) => importance(b) - importance(a) },
};
const SIZES = [10, 20, 40];

// { mode, size, status, candidates[], items[], picked:Set, kept, error, call }
let study = null;

// The shortest correction reads best next to the phrase; ties go to the most recent example.
const wordCount = (s) => norm(s).split(" ").filter(Boolean).length;
function studyExample(m) {
  const usable = m.examples.filter((e) => e.right?.trim());
  return usable.reduce((best, e) => (wordCount(e.right) < wordCount(best.right) ? e : best), usable[0]) ?? m.examples[0] ?? {};
}

const studyCandidates = () =>
  Object.values(mistakes).filter(pendingReview).sort(RANKERS[study.mode].sort).slice(0, study.size);

// Claude needs the source sentence to find the Swedish word when the mistake was made translating
// out of Swedish. It's on the history entry, which may since have been cleared.
function candidatePayload(m) {
  return {
    key: m.key,
    count: m.count,
    missed: missedAfterReview(m),
    examples: m.examples.slice(0, 3).map((e) => {
      const h = history.find((x) => x.id === e.entryId);
      return { from: h?.from, to: h?.to, source: h?.source ?? null, wrong: e.wrong, right: e.right, explanation: e.explanation };
    }),
  };
}

async function buildStudyList() {
  const candidates = studyCandidates();
  study = { ...study, status: "loading", candidates, items: [], picked: new Set(), error: null };
  const session = study; // hiding the panel mid-flight abandons the result
  renderMistakes();
  try {
    const body = await postJson("/api/studylist", { candidates: candidates.map(candidatePayload) });
    // The call is billed whether or not the panel is still open, so it's logged either way.
    const call = { ts: Date.now(), mode: session.mode, sent: candidates.length, kept: body.items.length, ...body.grader, ...body.usage };
    studyLog = [call, ...studyLog].slice(0, 200);
    save(KEYS.studylog, studyLog);
    if (study !== session) return;
    Object.assign(study, { items: body.items, picked: new Set(body.items.map((it) => it.key)), status: "done", call });
  } catch (e) {
    if (study !== session) return;
    Object.assign(study, { status: "error", error: e.message });
  }
  renderMistakes();
}

// Every candidate the list was built from is reviewed, ticked or not: you've now seen the verdict
// on all of them. Counts and examples stay, so repeats are still measured.
function applyReviewed() {
  const now = Date.now();
  for (const m of study.candidates) {
    if (mistakes[m.key]) mistakes[m.key].reviewedAt = now;
  }
  save(KEYS.mistakes, mistakes);
  study = { ...study, status: "applied", applied: study.candidates.length, candidates: [], items: [], picked: new Set() };
  renderMistakes();
}

const studyLines = () => (study.items ?? []).filter((it) => study.picked.has(it.key)).map((it) => it.phrase).join("\n");
const applyLabel = () => `mark all ${study.candidates.length} as reviewed`;

// Only the output pane changes when a box is ticked; the checklist keeps its scroll position.
function refreshStudyOutput(panel) {
  panel.querySelector(".study-lines").textContent = studyLines();
  panel.querySelector(".study-picked").textContent = `${study.picked.size} of ${study.items.length}`;
}

function renderStudyBody() {
  const pending = Object.values(mistakes).filter(pendingReview).length;
  if (study.status === "loading") return `<p class="study-note dots">Claude is reading ${study.candidates.length} mistakes</p>`;
  if (study.status === "error") return `<p class="study-note bad">Couldn't build the list: ${esc(study.error)}</p>`;
  if (study.status === "applied")
    return `<p class="study-note">${study.applied} marked reviewed. ${pending ? `${pending} left.` : "Nothing left to review."}</p>`;
  if (!pending) return `<p class="study-note">Nothing to review — every recorded mistake is marked reviewed.</p>`;
  if (study.status !== "done")
    return `<p class="study-note">${pending} mistake${pending === 1 ? "" : "s"} waiting. Claude keeps the ones worth learning as vocabulary — uncommon words, and words that govern a preposition — in dictionary form, and drops grammar, inflection and everyday words.</p>`;

  const dropped = study.candidates.length - study.items.length;
  if (!study.items.length)
    return `<p class="study-note">Nothing worth learning as vocabulary among those ${study.candidates.length} — all grammar, inflection or everyday words.</p>
      <button class="study-apply" data-apply>${applyLabel()}</button>`;

  const picks = study.items
    .map((it) => {
      const m = mistakes[it.key];
      const ex = m ? studyExample(m) : {};
      return `<li>
        <label>
          <input type="checkbox" data-pick="${esc(it.key)}"${study.picked.has(it.key) ? " checked" : ""}>
          <span class="p" lang="sv">${esc(it.phrase)}</span>
          <span class="note">${esc(it.note ?? "")}</span>
          ${m ? `<span class="n ${m.count === 1 ? "one" : ""}">${m.count}×</span>` : ""}
        </label>
        <div class="from"><s>${esc(ex.wrong ?? "")}</s> → <span class="r">${esc(ex.right ?? "")}</span>
          <span class="k">${esc(it.key)}</span>${m && missedAfterReview(m) ? `<span class="chip missed">missed after review</span>` : ""}</div>
      </li>`;
    })
    .join("");

  return `<div class="study-body">
      <ul class="study-picks">${picks}</ul>
      <div class="study-out">
        <div class="study-out-head">
          <span class="study-picked">${study.picked.size} of ${study.items.length}</span>
          <button class="link" data-copy>copy</button>
        </div>
        <pre class="study-lines" lang="sv">${esc(studyLines())}</pre>
        <button class="study-apply" data-apply>${applyLabel()}</button>
        <p class="study-fine">${dropped ? `${dropped} of the ${study.candidates.length} dropped as grammar or everyday words — marked reviewed too.` : "Everything sent was kept."}
          ${study.call ? `<br>${esc(graderLabel(study.call))} · ${fmtTokens(study.call.input)} in / ${fmtTokens(study.call.output)} out · ${study.call.cost == null ? "unknown price" : fmtCost(study.call.cost)}` : ""}</p>
      </div>
    </div>`;
}

function renderStudy() {
  if (!study) return "";
  const busy = study.status === "loading";
  const modes = Object.entries(RANKERS)
    .map(([id, r]) => `<button data-mode="${id}" class="${study.mode === id ? "on" : ""}"${busy ? " disabled" : ""}>${r.label}</button>`)
    .join("");
  const sizes = SIZES.map((n) => `<option value="${n}"${n === study.size ? " selected" : ""}>${n}</option>`).join("");
  const anyPending = Object.values(mistakes).some(pendingReview);
  return `<div class="study">
    <div class="study-head">
      <span class="seg">${modes}</span>
      <label class="study-size">top <select data-size${busy ? " disabled" : ""}>${sizes}</select></label>
      <button class="study-build" data-build${busy || !anyPending ? " disabled" : ""}>${study.status === "done" || study.status === "applied" ? "build again" : "build list"}</button>
      <button class="link" data-close>hide</button>
    </div>
    ${renderStudyBody()}
  </div>`;
}

function wireStudy(el) {
  const panel = el.querySelector(".study");
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t || t.disabled) return;
    // Changing the ranking or the size only changes what the next build asks for.
    if (t.dataset.mode) return void ((study.mode = t.dataset.mode), renderMistakes());
    if (t.dataset.build !== undefined) return void buildStudyList();
    if (t.dataset.close !== undefined) return void ((study = null), renderMistakes());
    if (t.dataset.apply !== undefined) return void applyReviewed();
    if (t.dataset.copy !== undefined) {
      navigator.clipboard?.writeText(studyLines()).then(
        () => {
          t.textContent = "copied";
          setTimeout(() => (t.textContent = "copy"), 1200);
        },
        () => {}
      );
    }
  });
  panel.addEventListener("change", (e) => {
    if (e.target.dataset?.size !== undefined) return void ((study.size = Number(e.target.value)), renderMistakes());
    const key = e.target.dataset?.pick;
    if (key === undefined) return;
    if (e.target.checked) study.picked.add(key);
    else study.picked.delete(key);
    refreshStudyOutput(panel);
  });
}

// ---------------------------------------------------------------------------
function renderMistakes() {
  const el = $("#mistakes");
  const list = Object.values(mistakes).sort((a, b) => b.count - a.count || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  if (!list.length) {
    study = null;
    el.classList.remove("wide");
    el.innerHTML = `<h2><span>mistakes</span><span class="h2-actions">${dataActions()}</span></h2><p class="empty">None recorded yet.</p>`;
    wireData(el);
    return;
  }
  const repeats = list.filter((m) => m.count > 1).length;
  const pending = list.filter(pendingReview).length;
  el.classList.toggle("wide", study?.status === "done" && study.items.length > 0);
  el.innerHTML = `<h2><span>mistakes · ${list.length} distinct · ${repeats} repeated · ${pending} to review</span>
    <span class="h2-actions">
      <button class="link" data-study>${study ? "hide study list" : "study list"}</button>
      ${dataActions()}
      <button class="clear" data-clear>clear</button>
    </span></h2>
    ${renderStudy()}
    ${list
      .map(
        (m) => `<div class="mistake-row">
        <div class="head">
          <span class="count ${m.count === 1 ? "one" : ""}">${m.count}×</span>
          <span class="k">${esc(m.key)}</span>
          ${
            missedAfterReview(m)
              ? `<span class="chip missed">missed after review</span>`
              : m.reviewedAt
                ? `<span class="chip done">reviewed ${fmtDate(m.reviewedAt)}</span>`
                : ""
          }
          <span class="cat">${esc(m.category)} · ${fmtDate(m.lastSeen)}</span>
        </div>
        <ul>${m.examples
          .slice(0, 3)
          .map((e) => `<li><s>${esc(e.wrong)}</s> → <span class="r">${esc(e.right)}</span> <span class="why">— ${esc(e.explanation)}</span></li>`)
          .join("")}</ul>
      </div>`
      )
      .join("")}`;
  wireStudy(el);
  wireData(el);
  el.querySelector("[data-study]").addEventListener("click", () => {
    study = study ? null : { mode: "important", size: 20, status: "idle", candidates: [], items: [], picked: new Set() };
    renderMistakes();
  });
  el.querySelector("[data-clear]").addEventListener("click", () => {
    if (!confirm("Forget all recorded mistakes?")) return;
    mistakes = {};
    study = null;
    save(KEYS.mistakes, mistakes);
    renderMistakes();
  });
}

// ---------------------------------------------------------------------------
// Export / import: everything saved, as JSON on the clipboard. Importing merges instead of replacing,
// and merging the same data twice changes nothing, so it's safe to sync devices back and forth.

const exportData = () => JSON.stringify({ glosor: 1, history, mistakes, studyLog });

// Pasted JSON may come from anywhere, and several fields are rendered unescaped, so numbers are
// forced to numbers and ids to the characters crypto.randomUUID() produces.
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const safeId = (x) => typeof x === "string" && /^[\w-]{1,64}$/.test(x);

function cleanEntry(h) {
  if (!h || !safeId(h.id) || typeof h.source !== "string" || !Array.isArray(h.references)) return null;
  const e = { ...h, ts: num(h.ts) };
  if (e.result) e.result = { ...e.result, score: num(e.result.score), mistakes: Array.isArray(e.result.mistakes) ? e.result.mistakes : [] };
  if (Array.isArray(e.gradings)) e.gradings = e.gradings.map((g) => ({ ...g, input: num(g.input), output: num(g.output), cost: g.cost == null ? null : num(g.cost) }));
  return e;
}

function cleanMistake(m, key) {
  if (!m || key === "__proto__" || m.key !== key || !Array.isArray(m.examples)) return null;
  return { ...m, examples: m.examples.filter((e) => e && typeof e === "object"), category: String(m.category ?? ""), count: num(m.count), lastSeen: num(m.lastSeen), reviewedAt: m.reviewedAt ? num(m.reviewedAt) : undefined };
}

// Returns how many history entries and mistake keys were new.
function mergeData(data) {
  if (data?.glosor !== 1) throw new Error("not glosor data");
  const known = new Set(history.map((h) => h.id));
  const newEntries = (Array.isArray(data.history) ? data.history : []).map(cleanEntry).filter((h) => h && !known.has(h.id));
  history = [...history, ...newEntries].sort((a, b) => b.ts - a.ts);

  let newKeys = 0;
  for (const [key, raw] of Object.entries(data.mistakes ?? {})) {
    const m = cleanMistake(raw, key);
    if (!m) continue;
    const local = mistakes[key];
    if (!local) {
      mistakes[key] = m;
      newKeys++;
      continue;
    }
    // Only the latest 12 examples are kept, so the true combined count is unknowable. Taking the
    // larger count plus any examples this device hasn't seen never double-counts a re-import.
    const seen = new Set(local.examples.map((e) => e.entryId));
    const fresh = m.examples.filter((e) => !seen.has(e.entryId));
    local.count = Math.max(local.count, m.count, local.count + fresh.length);
    local.examples = [...local.examples, ...fresh].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 12);
    local.lastSeen = Math.max(local.lastSeen ?? 0, m.lastSeen);
    if (m.reviewedAt) local.reviewedAt = Math.max(local.reviewedAt ?? 0, m.reviewedAt);
  }

  const calls = new Set(studyLog.map((c) => c.ts));
  const newCalls = (Array.isArray(data.studyLog) ? data.studyLog : []).filter((c) => c && !calls.has(num(c.ts)));
  studyLog = [...studyLog, ...newCalls.map((c) => ({ ...c, ts: num(c.ts), cost: c.cost == null ? null : num(c.cost) }))]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200);

  save(KEYS.history, history);
  save(KEYS.mistakes, mistakes);
  save(KEYS.studylog, studyLog);
  return { entries: newEntries.length, keys: newKeys };
}

const dataActions = () =>
  `<button class="link" data-export title="Copy all history and mistakes to the clipboard as JSON">copy</button>
   <button class="link" data-import title="Merge history and mistakes copied from another browser">merge</button>`;

function flash(btn, text) {
  const label = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = label), 1600);
}

// Reading the clipboard needs permission and isn't everywhere; a paste prompt is the fallback.
async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return prompt("Paste the copied glosor data:") ?? "";
  }
}

function wireData(el) {
  el.querySelector("[data-export]").addEventListener("click", (e) =>
    navigator.clipboard?.writeText(exportData()).then(() => flash(e.target, "copied"), () => flash(e.target, "couldn't copy"))
  );
  el.querySelector("[data-import]").addEventListener("click", async (e) => {
    const btn = e.target;
    const text = (await readClipboard()).trim();
    if (!text) return;
    let added;
    try {
      added = mergeData(JSON.parse(text));
    } catch {
      return flash(btn, "not glosor data");
    }
    route();
    // route() rebuilt the page, so the button that was clicked is gone.
    const fresh = document.querySelector(`#${el.id} [data-import]`);
    if (fresh) flash(fresh, `+${added.entries} answers, +${added.keys} mistakes`);
  });
}

function route() {
  if (gating) return;
  const view = location.hash.replace(/^#\/?/, "") || "play";
  for (const id of ["play", "history", "mistakes"]) $(`#${id}`).hidden = id !== view;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#/${view === "play" ? "" : view}`));
  if (view === "history") renderHistory();
  if (view === "mistakes") renderMistakes();
  if (view === "play" && !els.answer.disabled) els.answer.focus();
}

window.addEventListener("hashchange", route);
renderToggles();
api("/api/access")
  .catch(() => null)
  .then(async (cfg) => {
    accessCfg = cfg;
    if (cfg && !cfg.authed) await showGate();
    resume();
  });
