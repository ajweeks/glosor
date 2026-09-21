// Downloads human-translated English–Swedish parallel texts from OPUS and builds data/corpus.json.
//
//   npm run build-corpus
//
// Sources:
//   - OPUS Books: Jerome K. Jerome, "Three Men in a Boat" with its published Swedish translation
//     (aligned by András Farkas; free for personal/educational use, not for redistribution).
//   - OPUS TED2020: TED talk transcripts translated and reviewed by TED's volunteer translators.
//
// The raw downloads and the built corpus live in data/, which is git-ignored.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(root, "data");
const RAW = path.join(DATA, "raw");
fs.mkdirSync(RAW, { recursive: true });

const SOURCES = {
  books: {
    url: "https://object.pouta.csc.fi/OPUS-Books/v1/moses/en-sv.txt.zip",
    files: ["Books.en-sv.en", "Books.en-sv.sv", "Books.en-sv.ids"],
  },
  ted: {
    url: "https://object.pouta.csc.fi/OPUS-TED2020/v1/moses/en-sv.txt.zip",
    files: ["TED2020.en-sv.en", "TED2020.en-sv.sv", "TED2020.en-sv.xml"],
  },
};

const BOOKS = {
  "Jerome_Jerome_K-Three_Men_in_a_Boat": {
    title: "Three Men in a Boat",
    author: "Jerome K. Jerome",
    url: "https://www.gutenberg.org/ebooks/308",
  },
};

async function download(name, { url, files }) {
  const dir = path.join(RAW, name);
  if (files.every((f) => fs.existsSync(path.join(dir, f)))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(RAW, `${name}.zip`);
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-oq", zip, "-d", dir]);
  fs.rmSync(zip);
  return dir;
}

const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n");

const clean = (s) =>
  s
    .replace(/\s+--\s+/g, " — ")
    .replace(/\s+/g, " ")
    .trim();

const words = (s) => s.split(/\s+/).filter(Boolean).length;

// The two sides are aligned line for line, but they aren't always split into sentences at the same
// places: a Swedish sentence can run past the end of its line and finish inside the next one, which
// pairs it with different English. Such a line ends mid-sentence ("…, utan också"), so requiring a
// sentence-final mark on both sides throws the halves away instead of showing a cut-off reference.
const ENDS_SENTENCE = /[.!?…][")»”’'\]]*$/;

// Parts of the Swedish side reached OPUS with å, ä and ö stripped ("nagot", "valdsamma"). Such a
// reference is misspelled, and would mark the learner's correct spelling as a divergence. These
// words don't exist without their diacritics, so one of them is proof the line lost them.
const STRIPPED_DIACRITICS =
  /\b(fran|nagot|nagon|nagra|sjalv|sjalva|aven|maste|gora|manniska|manniskor|ocksa|darfor|dar|nar|forsta|tankte|kande|horde|borjade|langre|storre|kopa|fragor|fraga|atminstone|valdsam\w*|aterstall\w*|avhallsam\w*)\b/i;

// Reject units that are likely misaligned, noisy, or not real prose.
function usable(en, sv) {
  if (!en || !sv) return false;
  if (!ENDS_SENTENCE.test(en) || !ENDS_SENTENCE.test(sv)) return false; // split across lines
  if (STRIPPED_DIACRITICS.test(sv)) return false;
  if (/[()[\]♫♪]/.test(en + sv)) return false; // (Laughter), (Skratt), music
  if (/^[A-ZÅÄÖ]{1,3}:/.test(en) || /^[A-ZÅÄÖ]{1,3}:/.test(sv)) return false; // speaker labels
  if (/https?:|www\./.test(en + sv)) return false;
  const ratio = sv.length / en.length;
  return ratio > 0.7 && ratio < 1.45;
}

// Each doc is an ordered list of { en, sv, ref } units (ref = locator inside the doc).
function loadBooks(dir) {
  const [en, sv, ids] = SOURCES.books.files.map((f) => read(dir, f));
  const docs = new Map();
  en.forEach((line, i) => {
    if (!ids[i]) return;
    const [enDoc, , enIds] = ids[i].split("\t");
    const key = path.basename(enDoc, ".xml.gz");
    if (!docs.has(key)) docs.set(key, []);
    docs.get(key).push({ en: clean(line), sv: clean(sv[i] ?? ""), ref: enIds.split(" ")[0] });
  });
  return [...docs].map(([key, units]) => {
    const meta = BOOKS[key] ?? { title: key.replace(/_/g, " "), author: "", url: "https://opus.nlpl.eu/Books.php" };
    return {
      units,
      meta: {
        kind: "book",
        label: meta.title,
        title: `${meta.title} by ${meta.author}, published Swedish translation · OPUS Books`,
        url: meta.url,
        license: "Farkas bilingual books: personal & educational use",
      },
    };
  });
}

function loadTed(dir) {
  const [en, sv, xml] = SOURCES.ted.files.map((f) => read(dir, f));
  // Moses files separate talks with a blank line, in the same order as the linkGrps in the XML.
  const talkIds = xml.flatMap((l) => l.match(/fromDoc="en\/ted2020-(\d+)\.xml\.gz"/)?.[1] ?? []);
  const docs = [];
  let units = [];
  let n = 0;
  for (let i = 0; i < en.length; i++) {
    if (en[i].trim() === "" && (sv[i] ?? "").trim() === "") {
      if (units.length) docs.push(units);
      units = [];
      n = 0;
      continue;
    }
    units.push({ en: clean(en[i]), sv: clean(sv[i] ?? ""), ref: ++n });
  }
  if (units.length) docs.push(units);
  if (docs.length !== talkIds.length) throw new Error(`TED: ${docs.length} docs vs ${talkIds.length} talk ids`);

  return docs.map((units, d) => ({
    units,
    meta: {
      kind: "talk",
      label: `TED talk ${talkIds[d]}`,
      title: `TED talk ${talkIds[d]} · volunteer translation (OPUS TED2020), line`,
      url: `https://www.ted.com/talks/${talkIds[d]}`,
      license: "TED Talks Usage Policy (CC BY–NC–ND)",
    },
  }));
}

// Output is compact: docs hold the source metadata once, items are [docIndex, ref, en, sv].
function build(loaded, tag) {
  const docs = loaded.map((d) => d.meta);
  const sentences = [];
  const passages = [];
  const seen = new Set();

  loaded.forEach((doc, d) => {
    const u = doc.units;
    for (const { en, sv, ref } of u) {
      const w = words(en);
      if (w >= 12 && w <= 45 && usable(en, sv) && !seen.has(en)) {
        seen.add(en);
        sentences.push([d, ref, en, sv]);
      }
    }
    // Passages: runs of 2–5 consecutive usable units, 35–100 English words, non-overlapping.
    for (let i = 0; i < u.length; ) {
      let j = i, w = 0;
      while (j < u.length && j - i < 5 && w < 35 && usable(u[j].en, u[j].sv)) w += words(u[j++].en);
      if (j - i >= 2 && w >= 35 && w <= 100) {
        const run = u.slice(i, j);
        passages.push([d, run[0].ref, run.map((x) => x.en).join(" "), run.map((x) => x.sv).join(" ")]);
        i = j;
      } else i++;
    }
  });
  console.log(`${tag}: ${sentences.length} long sentences, ${passages.length} passages`);
  return { docs, sentences, passages };
}

const books = build(loadBooks(await download("books", SOURCES.books)), "books");
const ted = build(loadTed(await download("ted", SOURCES.ted)), "ted");

const out = path.join(DATA, "corpus.json");
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), books, ted }));
console.log(`wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
