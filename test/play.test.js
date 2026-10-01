// Play-screen flow: skip reveals the translation, the next press moves on, and changing the
// direction or length partway through a round doesn't break either step.
//
// app.js runs in a jsdom window with a fake server. Each test boots a fresh copy of the module.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
let boots = 0;
let windows = [];
afterEach(() => {
  for (const w of windows) w.close();
  windows = [];
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

// With `manual`, sentence requests wait until the test answers them, so it can act mid-load.
async function boot({ dir = "swe", length = "short", manual = false } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.localStorage.setItem("glosor.dir", JSON.stringify(dir));
  w.localStorage.setItem("glosor.length", JSON.stringify(length));

  let n = 0;
  const sentences = []; // every sentence the server handed out, in request order
  const grades = [];
  const json = (body, status = 200) => ({ ok: status < 300, status, statusText: "", json: async () => body });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/api/access") return json({ gated: false, authed: true });
    if (u.pathname === "/api/graders") return json({ models: {}, default: {} });
    if (u.pathname === "/api/sentence") {
      const from = u.searchParams.get("from");
      const len = u.searchParams.get("length");
      const id = ++n;
      const s = {
        from,
        to: from === "swe" ? "eng" : "swe",
        length: len,
        text: `source ${id} (${from} ${len})`,
        references: [{ text: `reference ${id}` }, { text: `alternative ${id}` }],
        source: { url: "https://example.com", label: "example", title: "example", license: "CC" },
      };
      const req = { ...s, id };
      sentences.push(req);
      if (!manual) return json(s);
      return new Promise((resolve) => (req.respond = () => resolve(json(s))));
    }
    if (u.pathname === "/api/grade") {
      grades.push(JSON.parse(opts.body));
      return json({ score: 70, verdict: "minor_errors", feedback: "Nearly.", mistakes: [] });
    }
    return json({ error: "not found" }, 404);
  };

  Object.assign(globalThis, {
    window: w,
    document: w.document,
    localStorage: w.localStorage,
    location: w.location,
    fetch,
    confirm: () => true,
    prompt: () => "",
  });
  Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true, writable: true });

  await import(`../public/app.js?boot=${++boots}`);
  await settle();

  const $ = (sel) => w.document.querySelector(sel);
  const answer = $("#answer");
  const app = {
    w,
    sentences,
    grades,
    source: () => $("#source").textContent,
    result: () => $("#result").textContent,
    answer,
    hintButtons: () => [...$("#hint").querySelectorAll("button")].map((b) => b.textContent),
    // Keys go where the browser would send them: the answer box while it's usable, else the page.
    async press(key) {
      const target = answer.disabled ? w.document.body : answer;
      target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await settle();
    },
    async click(sel) {
      $(sel).click();
      await settle();
    },
    async type(text) {
      answer.value = text;
      answer.dispatchEvent(new w.Event("input", { bubbles: true }));
      await settle();
    },
    history: () => JSON.parse(w.localStorage.getItem("glosor.history") ?? "[]"),
  };
  return app;
}

const shown = (app) => app.sentences.find((s) => s.text === app.source());

test("skip shows the translation, then the next press moves on", async () => {
  const app = await boot();
  const first = shown(app);
  assert.ok(first, "a sentence is showing");
  assert.deepEqual(app.hintButtons(), ["skip", "submit"]);

  await app.press("Escape");
  assert.equal(app.source(), first.text, "still on the same sentence");
  assert.match(app.result(), /reference 1/);
  assert.match(app.result(), /alternative 1/);
  assert.ok(app.answer.disabled, "no more answering once the translation is out");
  assert.deepEqual(app.hintButtons(), ["next"]);

  await app.press("Escape");
  const second = shown(app);
  assert.ok(second && second !== first, "moved on to a new sentence");
  assert.equal(app.result(), "");
  assert.ok(!app.answer.disabled);
  assert.deepEqual(app.hintButtons(), ["skip", "submit"]);
});

test("the skip and next buttons do the same as the keys", async () => {
  const app = await boot();
  const first = shown(app);

  await app.click("[data-skip]");
  assert.equal(app.source(), first.text);
  assert.match(app.result(), /reference 1/);

  await app.click("[data-next]");
  assert.notEqual(app.source(), first.text);
  assert.equal(app.result(), "");
});

test("Enter after a reveal moves on too", async () => {
  const app = await boot();
  const first = shown(app);
  await app.press("Escape");
  assert.equal(app.source(), first.text);
  await app.press("Enter");
  assert.notEqual(app.source(), first.text);
  assert.ok(!app.answer.disabled);
});

test("a revealed round can't be submitted", async () => {
  const app = await boot();
  const first = shown(app);
  await app.type("my half-finished answer");
  assert.ok(!app.w.document.querySelector("[data-submit]").disabled);

  await app.press("Escape");
  assert.equal(app.answer.value, "my half-finished answer", "the typed answer stays visible");
  assert.ok(app.answer.disabled);
  assert.equal(app.w.document.querySelector("[data-submit]"), null, "no submit button while revealed");

  // Enter reaches the page, not the disabled box: it moves on instead of grading.
  await app.press("Enter");
  assert.equal(app.grades.length, 0, "nothing was sent for grading");
  assert.deepEqual(app.history(), [], "nothing was recorded");
  assert.notEqual(app.source(), first.text);
  assert.equal(app.answer.value, "");
});

test("changing mode after a reveal keeps the reveal, and the next sentence uses the new mode", async () => {
  const app = await boot({ dir: "swe", length: "short" });
  const first = shown(app);
  await app.press("Escape");

  await app.click("#dir"); // swe → eng
  await app.click("#length"); // short → long
  assert.equal(app.source(), first.text, "the revealed sentence stays put");
  assert.match(app.result(), /reference 1/);
  assert.ok(app.answer.disabled);
  assert.deepEqual(app.hintButtons(), ["next"]);

  await app.press("Enter");
  const next = shown(app);
  assert.equal(next.from, "eng");
  assert.equal(next.length, "long");
  assert.equal(app.answer.lang, "sv");
  assert.equal(app.result(), "");

  // And the new round skips like any other.
  await app.press("Escape");
  assert.equal(app.source(), next.text);
  assert.match(app.result(), new RegExp(`reference ${next.id}\\b`));
  await app.press("Escape");
  assert.notEqual(app.source(), next.text);
});

test("changing mode with an answer typed keeps the sentence, and skip still reveals it", async () => {
  const app = await boot({ dir: "swe", length: "short" });
  const first = shown(app);
  await app.type("halfway");

  await app.click("#dir");
  assert.equal(app.source(), first.text, "a typed answer isn't thrown away");

  await app.press("Escape");
  assert.equal(app.source(), first.text);
  assert.match(app.result(), /reference 1/);

  await app.press("Escape");
  assert.equal(shown(app).from, "eng");
});

test("changing mode on an untouched sentence swaps it, and skip reveals the new one", async () => {
  const app = await boot({ dir: "swe", length: "short" });
  const first = shown(app);

  await app.click("#length");
  const swapped = shown(app);
  assert.notEqual(swapped, first);
  assert.equal(swapped.length, "long");

  await app.press("Escape");
  assert.equal(app.source(), swapped.text);
  assert.match(app.result(), new RegExp(`reference ${swapped.id}\\b`));
  assert.doesNotMatch(app.result(), /reference 1\b/);
});

test("changing mode while a sentence is loading ends up on the new mode's sentence", async () => {
  const app = await boot({ dir: "swe", length: "short", manual: true });
  assert.equal(app.sentences.length, 1, "first sentence requested");
  assert.ok(app.answer.disabled);

  await app.click("#dir"); // swe → eng, while the swe sentence is still in flight
  assert.equal(app.sentences.length, 2);
  const [stale, fresh] = app.sentences;

  // The new request answers first, then the stale one straggles in.
  fresh.respond();
  await settle();
  stale.respond();
  await settle();

  assert.equal(app.source(), fresh.text, "the stale sentence didn't overwrite the new one");
  assert.equal(shown(app).from, "eng");

  await app.press("Escape");
  assert.equal(app.source(), fresh.text);
  assert.match(app.result(), new RegExp(`reference ${fresh.id}\\b`));
  assert.deepEqual(app.hintButtons(), ["next"]);
});

test("graded rounds are unaffected: submit, change mode, then next", async () => {
  const app = await boot({ dir: "swe", length: "short" });
  const first = shown(app);
  await app.type("an attempt");
  await app.press("Enter");
  await app.press("f");
  assert.equal(app.grades.length, 1);
  assert.match(app.result(), /Nearly\./);
  assert.deepEqual(app.hintButtons(), ["next"]);
  assert.equal(app.history().length, 1);

  await app.click("#dir");
  assert.equal(app.source(), first.text, "the graded round stays until you move on");

  await app.press("Enter");
  assert.equal(shown(app).from, "eng");
  assert.deepEqual(app.hintButtons(), ["skip", "submit"]);
});

test("a wrong answer shows the diff without grading; F asks for feedback", async () => {
  const app = await boot();
  await app.type("an attempt");
  await app.press("Enter");
  assert.equal(app.grades.length, 0, "nothing sent until asked");
  assert.match(app.result(), /reference/);
  assert.deepEqual(app.hintButtons(), ["feedback", "next"]);

  await app.press("f");
  assert.equal(app.grades.length, 1);
  assert.match(app.result(), /Nearly\./);
  assert.deepEqual(app.hintButtons(), ["next"]);
  await app.press("f");
  assert.equal(app.grades.length, 1, "F does nothing once graded");
});

test("the feedback button grades too", async () => {
  const app = await boot();
  await app.type("an attempt");
  await app.press("Enter");
  await app.click("[data-feedback]");
  assert.equal(app.grades.length, 1);
  assert.equal(app.history().length, 1);
});

test("Enter on an ungraded answer moves on without grading", async () => {
  const app = await boot();
  const first = shown(app);
  await app.type("an attempt");
  await app.press("Enter");
  await app.press("Enter");
  assert.equal(app.grades.length, 0);
  assert.notEqual(app.source(), first.text);
  assert.deepEqual(app.hintButtons(), ["skip", "submit"]);
});
