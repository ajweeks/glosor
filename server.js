import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import * as access from "./access.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT) || 5173;
// Grader models the UI may pick from, with the effort levels offered for each (Haiku 4.5 has no effort setting).
const GRADERS = {
  "claude-haiku-4-5": [null],
  "claude-sonnet-5": ["low", "medium", "high"],
};

function resolveGrader(model, effort) {
  if (!GRADERS[model]) model = "claude-sonnet-5";
  const efforts = GRADERS[model];
  return { model, effort: efforts.includes(effort) ? effort : efforts.includes("medium") ? "medium" : efforts[0] };
}

// USD per million tokens (Claude API list prices). Thinking tokens are billed as output.
const PRICES = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
};

// Estimated cost of one call, priced at the model that served it.
function costOf(model, usage) {
  const price = PRICES[model] ?? PRICES[Object.keys(PRICES).find((m) => model.startsWith(m))];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cost = price
    ? (input * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.input * 0.1 + output * price.output) / 1e6
    : null;
  return { input: input + cacheWrite + cacheRead, output, cost };
}

// Default grader, overridable with MODEL / EFFORT.
const DEFAULT_GRADER = resolveGrader(process.env.MODEL || "claude-sonnet-5", process.env.EFFORT || "medium");

const client = new Anthropic();

// ---------------------------------------------------------------------------
// Sources
//
// Tatoeba: human-written, community-reviewed sentence pairs (CC BY 2.0 FR), fetched live.
// Corpus (optional, `npm run build-corpus`): a published translation of "Three Men in a Boat"
// and volunteer-translated TED talks, both via OPUS. Used for long sentences and passages.

const LANGS = { swe: "Swedish", eng: "English" };
const LENGTHS = new Set(["short", "long", "passage"]);
const other = (lang) => (lang === "swe" ? "eng" : "swe");

const corpus = loadCorpus();

function loadCorpus() {
  const file = path.join(here, "data", "corpus.json");
  if (!existsSync(file)) {
    console.log("No data/corpus.json; long sentences come from Tatoeba only and passages are unavailable. Run `npm run build-corpus`.");
    return null;
  }
  const c = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["books", "ted"]) console.log(`corpus ${k}: ${c[k].sentences.length} sentences, ${c[k].passages.length} passages`);
  return c;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function fromCorpus(set, kind, from) {
  const [doc, ref, en, sv] = pick(corpus[set][kind]);
  const meta = corpus[set].docs[doc];
  const [text, reference] = from === "eng" ? [en, sv] : [sv, en];
  return {
    id: `${set}:${doc}:${ref}`,
    from,
    to: other(from),
    text,
    references: [{ text: reference }],
    source: {
      kind: meta.kind,
      label: meta.label,
      title: `${meta.title} ${ref}`,
      url: meta.url,
      license: meta.license,
    },
  };
}

// Tatoeba results are pooled per (direction, word-count range) and refilled in the background.
const TATOEBA_WORDS = { short: "4-", long: "12-" };
const pools = {};
const refilling = {};

async function fetchTatoeba(from, length) {
  const to = other(from);
  const url = new URL("https://api.tatoeba.org/v1/sentences");
  url.searchParams.set("lang", from);
  url.searchParams.set("trans:lang", to);
  url.searchParams.set("is_orphan", "no");
  url.searchParams.set("is_unapproved", "no");
  url.searchParams.set("word_count", TATOEBA_WORDS[length]);
  url.searchParams.set("sort", "random");
  url.searchParams.set("showtrans", "matching");
  url.searchParams.set("limit", "50");

  const res = await fetch(url, { headers: { "User-Agent": "glosor/1.0" } });
  if (!res.ok) throw new Error(`Tatoeba responded ${res.status}`);
  const { data } = await res.json();

  return data
    .map((s) => {
      const refs = s.translations
        .filter((t) => t.lang === to && !t.is_unapproved)
        // Direct translations first: they were written against this exact sentence.
        .sort((a, b) => Number(b.is_direct) - Number(a.is_direct));
      return {
        id: `tatoeba:${s.id}`,
        from,
        to,
        text: s.text,
        references: refs.map((t) => ({ text: t.text, url: `https://tatoeba.org/en/sentences/show/${t.id}` })),
        source: {
          kind: "tatoeba",
          label: `tatoeba #${s.id}`,
          title: `Tatoeba sentence by ${s.owner}`,
          url: `https://tatoeba.org/en/sentences/show/${s.id}`,
          license: s.license,
        },
      };
    })
    .filter((s) => s.references.length > 0);
}

function refill(key, from, length) {
  pools[key] ??= [];
  refilling[key] ??= fetchTatoeba(from, length)
    .then((items) => pools[key].push(...items))
    .finally(() => (refilling[key] = null));
  return refilling[key];
}

async function fromTatoeba(from, length) {
  const key = `${from}:${length}`;
  if (!pools[key]?.length) await refill(key, from, length);
  const item = pools[key].shift();
  if (pools[key].length < 10) refill(key, from, length).catch((e) => console.error(e.message));
  if (!item) throw new Error("No sentences available");
  return item;
}

async function nextSentence(from, length) {
  let item;
  if (length === "short" || !corpus) {
    if (length === "passage") throw new Error("Passages need the corpus: run `npm run build-corpus` and restart.");
    item = await fromTatoeba(from, length);
  } else if (length === "long") {
    // Equal thirds: Tatoeba, the book, TED talks.
    const r = Math.random();
    item = r < 1 / 3 ? await fromTatoeba(from, "long") : fromCorpus(r < 2 / 3 ? "books" : "ted", "sentences", from);
  } else {
    item = fromCorpus(Math.random() < 0.5 ? "books" : "ted", "passages", from);
  }
  return { ...item, length };
}

// ---------------------------------------------------------------------------
// Grading with Claude.

const SYSTEM = `Du granskar översättningar mellan svenska och engelska.

Eleven får en mening eller ett kort stycke på ett språk och skriver en översättning. Du får källtexten, en eller flera mänskliga referensöversättningar och elevens försök.

Ge saklig återkoppling om vad som var rätt eller fel, utan artighetsfraser eller beröm. Kommentera inte utelämnad interpunktion eller andra oviktiga skillnader (stor eller liten bokstav, sammandragningar som "don't" mot "do not"), och ta inte upp dem som fel. Fokusera däremot på att rätta onaturliga formuleringar och direkt felaktig ordanvändning.

Referenserna är korrekta men inte uttömmande: varje trogen och naturlig översättning är rätt, även om den är formulerad på ett annat sätt. Vissa källor (en utgiven romanöversättning, textade föredrag) har friare och mer litterära referenser; eleven förväntas inte återge de stilvalen.

Ge varje fel en nyckel på formen "<kategori>:<specifik-sak>" med gemener och bindestreck. Nycklarna skrivs ALLTID på engelska, oavsett vilket språk återkopplingen är på, t.ex. "word-order:v2-after-adverbial", "gender:ett-hus", "vocab:borde-vs-skulle", "tense:perfect-vs-preterite", "definiteness:double-definite", "preposition:på-vs-i", "idiom:unnatural-phrasing". Ta upp varje enskilt fel en gång.

Återkoppling: 1–4 korta meningar på svenska, riktade till eleven ("du"), om vad som avviker och varför. Förklaringarna till felen skrivs också på svenska. Skriv alltid på svenska, även när eleven har översatt från svenska till engelska och även när felet gäller ett engelskt ord. Ingen inledning, inga rubriker. Endast oformaterad text: ingen Markdown, inga HTML-entiteter, inga radbrytningar. Skriv svenska med sina riktiga bokstäver (å, ä, ö) precis som de stavas; använd aldrig escape-sekvenser och byt aldrig ut eller utelämna dem.

Nedan följer en checklista över typiska fel i svenskan. Den gäller i första hand när eleven skriver på svenska, den är inte uttömmande, och den upphäver inte reglerna ovan: strunta fortfarande i interpunktion och stor/liten bokstav, och godta varje trogen och naturlig formulering även om den inte står här.

SÄRSKRIVNING ("compound:...")
Svenskan skriver samman sammansättningar till ett ord. Särskrivning ändrar betydelsen och är ett riktigt fel, inte en småsak.
✘ brun hårig sjuk sköterska → ✓ brunhårig sjuksköterska
✘ Rök fritt ("rök gärna") → ✓ Rökfritt
✘ kyckling lever ("kycklingen lever") → ✓ kycklinglever
Undantag finns (till slut, för sent) och bindestreck är ovanligt, men används när ett främmande ord behålls oöversatt: Unbabel-formulär, Ethernet-kabeln.

GENUS OCH KONGRUENS ("gender:...", "agreement:...")
Två genus, utrum (en) och neutrum (ett), som styr bestämd form, adjektiv och pronomen:
en banan – bananen – en grön banan – bananen är grön – den är grön
ett tak – taket – ett grönt tak – taket är grönt – det är grönt
✘ Bananet är grönt → ✓ Bananen är grön
Vissa ord tillåter båda genusen (en/ett individ, en/ett test) — räkna inte det som fel.

VERBFORMER ("verb-form:...", "tense:...")
Verb böjs inte efter person eller numerus. Efter hjälpverb står infinitiv, inte supinum:
✘ Hur har ni hunnit gjort allt detta? → ✓ Hur har ni hunnit göra allt detta?
Infinitivmärket "att" faller ofta bort felaktigt efter "kommer":
✘ Vi kommer spela en låt → ✓ Vi kommer att spela en låt
Passiv bildas med -s (stärker → stärks, förklarar → förklaras) och används oftare i svenska än i engelska, särskilt i sakprosa:
✘ Planen förklarar för publiken → ✓ Planen förklaras för publiken
Konjunktiv är ålderdomlig utom "vore".

ENGELSKANS -ING ("literal:...", "idiom:...")
-ing-formen har ingen direkt motsvarighet utan översätts efter satsdel och sammanhang: samordning (The hunter is sitting on a chair reading → Jägaren sitter på en stol och läser), tidsbisats (On arriving at the office → Då hon kom till kontoret), relativsats (all matters relating to horses → allt som har med hästar att göra), orsaksbisats (Being a jockey → Då hon är jockey), bisats med att (Excuse my changing the subject → Ursäkta att jag byter samtalsämne), particip (a surprising win → en överraskande seger), infinitiv (He hates reading → Han hatar att läsa) eller sammansatt substantiv (Horse racing → Hästkapplöpning).
✘ allt relaterande till hästar → ✓ allt som har med hästar att göra

SIN ELLER HANS/HENNES/DERAS ("reflexive:...")
Reflexivt possessivpronomen (sin, sitt, sina) syftar på satsens subjekt, hans/hennes/deras på någon annan. Engelskans "his" täcker båda.
Patrik kysser sin fru = sin egen. Patrik kysser hans fru = någon annans.

DE OCH DEM ("pronoun:de-dem")
"de" är subjekt och bestämd artikel, "dem" är objekt eller står efter preposition. "dom" hör inte hemma i skrift.
✓ De nya stolarna köpte de i Malmö. ✓ Jag älskar de nya stolarna. ✓ Jag tänker bara på dem.
Artikeln är alltid "de", också inuti ett objekt: ✘ dem skivor som hon hyllat → ✓ de skivor som hon hyllat
Minnesregel: där du kan sätta "vi" skrivs "de", där du kan sätta "oss" skrivs "dem". Efter "som" är båda tillåtna (de/dem som lagar stolar).

PREPOSITIONER ("preposition:...")
Prepositionen styrs av uttrycket, inte av engelskan:
✘ Jag skrattar på dig → ✓ Jag skrattar åt dig

GENITIV ("genitive:...")
Genitiv-s skrivs utan apostrof, och namn som redan slutar på s får inget tillägg:
✘ Rasmus' tröja → ✓ Rasmus tröja

TILLTAL OCH REGISTER ("register:...")
Svenskan duar. Engelskans "you/your" blir "du/dig/din", aldrig "ni/er", även i formella texter och tilltal från myndigheter. Hälsningsfraser som Hey, Hello, Dear X blir "Hej" eller "Hej X". Formellt register förekommer främst i vetenskaplig text: längre meningar, passiv, valda ord (eftersöka i stället för söka efter). Vardagliga former (sen, nån, sa, la) godtas i mycket informell text och skrivs utan apostrof. Ett register som ligger långt från källans — kanslisvenska i en lättsam reklamtext eller tvärtom — är ett fel värt att nämna.

ÖVERSÄTTNINGENS FLYT ("literal:...", "idiom:...")
Det vanligaste felet är att följa engelskan ord för ord. En trogen översättning måste ofta formuleras om för att låta naturlig på svenska.
✘ kärlek är att engagera viljan i andra personers sanna välbefinnande → ✓ kärlek är att hänge sig till det uppriktigt goda hos andra personer

EGENNAMN OCH FÖRKORTNINGAR ("proper-noun:...", "acronym:...")
Personnamn översätts inte, utom när en internationellt känd figur har ett etablerat svenskt namn (Donald Duck → Kalle Anka). Länder och städer översätts när det finns en svensk form (Germany → Tyskland, Prague → Prag, Czech Republic → Tjeckien). Organisationer, varumärken, produkter, verk och evenemang behålls, om inte ett vedertaget svenskt namn finns. Akronymer översätts bara när en svensk finns: UN → FN, annars behålls akronymen och förklaras vid behov.
Förkortningar: etc. → o.s.v., i.e. → d.v.s., e.g. → t.ex. — med punkter eller mellanslag, aldrig både och, och aldrig "tex".

TAL, MÅTT OCH TID ("number-format:...", "false-friend:...")
Siffror eller bokstäver följer källtexten. Tusental avdelas med mellanslag (20 000, inte 20,000 eller 20.000) och decimaler skrivs med komma (2,1 barn per hushåll). Punkt används bara i t.ex. versionsnummer. Symboler föregås av mellanslag: 5 %, 5 °C, 100 $, 100 USD, och valutasymbolen står efter talet. Utskriven valuta har liten bokstav (100 euro). Mått räknas aldrig om, inte heller enheter som saknas i svenskan (20 ft.). Datum skrivs 2001-08-31 eller 31 augusti 2001, klockslag med 24-timmarsklocka (10:59 p.m. → 22:59).
Falsk vän: engelskans "billions" är "miljarder", inte "biljoner".
`;

const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "verdict", "feedback", "mistakes"],
  properties: {
    score: { type: "integer", description: "0–100, hur bra översättningen är" },
    verdict: { type: "string", enum: ["correct", "acceptable", "minor_errors", "major_errors"] },
    feedback: { type: "string", description: "på svenska" },
    mistakes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "category", "wrong", "right", "explanation"],
        properties: {
          key: { type: "string", description: "på engelska, kebab-case" },
          category: { type: "string", description: "på engelska" },
          wrong: { type: "string", description: "elevens felaktiga fragment" },
          right: { type: "string", description: "det rättade fragmentet" },
          explanation: { type: "string", description: "på svenska" },
        },
      },
    },
  },
};

const SOURCE_KINDS = {
  tatoeba: "Tatoeba (crowdsourcade, granskade meningspar)",
  book: "utgiven litterär översättning (Jerome K. Jerome, Tre män i en båt; äldre svenska)",
  talk: "transkription av ett TED-föredrag, översatt av volontärer",
};

// The grading prompt is Swedish throughout, so the source language is named in Swedish too.
const LANGS_SV = { swe: "svenska", eng: "engelska" };

async function grade({ from, to, source, references, attempt, sourceKind, grader }) {
  const prompt = [
    `Riktning: ${LANGS_SV[from]} → ${LANGS_SV[to]}`,
    `Referensens ursprung: ${SOURCE_KINDS[sourceKind] ?? SOURCE_KINDS.tatoeba}`,
    `Källtext (${LANGS_SV[from]}): ${source}`,
    `Referensöversättning(ar) (${LANGS_SV[to]}):`,
    ...references.map((r) => `- ${r}`),
    `Elevens försök: ${attempt}`,
  ].join("\n");

  const params = {
    model: grader.model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      ...(grader.effort && { effort: grader.effort }),
      format: { type: "json_schema", schema: GRADE_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  };
  const response = await client.messages.create(params);

  if (response.stop_reason === "refusal") throw new Error("The model declined to grade this attempt.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (response.stop_reason !== "end_turn" || !text) {
    console.warn("grade:", response.stop_reason, JSON.stringify(response.content).slice(0, 2000));
  }
  if (!text) throw new Error(`No grading returned (stop_reason: ${response.stop_reason})`);
  return {
    ...unescapeStrings(JSON.parse(text)),
    grader: { ...grader, servedBy: response.model },
    usage: costOf(response.model, response.usage),
  };
}

// ---------------------------------------------------------------------------
// Study list: recorded mistakes \u2192 a Swedish vocabulary list.
//
// Only vocabulary worth memorising survives: grammar, inflection and everyday words are dropped,
// and what's kept is rewritten into its dictionary form.

const STUDY_SYSTEM = `You turn a Swedish learner's recorded mistakes into a vocabulary study list.

Each candidate is one recorded mistake: a key, how often it was made, and up to three examples with the source sentence, the fragment the learner wrote, the correction, and a note on why. The learner translates in both directions, so the fragments are sometimes English. The study item is ALWAYS Swedish: when the mistake was made translating out of Swedish, take it from the source sentence.

Keep a candidate only if it is worth memorising as vocabulary:
- less common words a learner would have to look up ("en likriktning", "kantonesiska", "att belasta")
- collocations where a Swedish word governs a particular preposition or particle ("ben\u00e4gen till", "att bero p\u00e5")
- fixed idioms whose meaning doesn't follow from their parts

Drop everything else. In particular drop:
- inflection and agreement: tense, supine, passive ("som levts" \u2192 "som levs"), plural, definiteness, adjective agreement
- word order, punctuation, spelling, capitalisation
- everyday words any beginner already knows
- anything whose Swedish item you cannot identify from what you were given

Drop silently: return nothing at all for a candidate you drop, and never explain the omission.

Write each kept item in its dictionary form and nothing else \u2014 no English, no gloss, no brackets inside the phrase:
- noun: indefinite singular with its article \u2014 "en likriktning", "ett hus"
- verb: "att" + infinitive \u2014 "att belasta"
- verb phrase or idiom built on a verb: "att" + infinitive as well \u2014 "att ta del av", "att tycka om"
- adjective or participle: base (common gender, singular) form \u2014 "ben\u00e4gen"
- collocation: the CORRECT pairing, each part in base form \u2014 "ben\u00e4gen till", "att bero p\u00e5"
- what has no article or infinitive (language names, adverbs, fixed phrases): as it stands \u2014 "kantonesiska"
Never definite, never plural, never inflected for tense. Write \u00e5, \u00e4 and \u00f6 as themselves; never escape or transliterate them.

Give each kept item the candidate's key verbatim, so it can be matched back, and at most one item per candidate. If two candidates yield the same phrase, keep the stronger one only.

"note" is at most six English words naming the sense ("propensity for", "Cantonese", "to burden") \u2014 the learner will study the phrase without the source sentence in front of them.`;

const STUDY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "phrase", "note"],
        properties: {
          key: { type: "string", description: "the candidate's key, verbatim" },
          phrase: { type: "string", description: "the Swedish word or phrase in dictionary form" },
          note: { type: "string", description: "at most six English words naming the sense" },
        },
      },
    },
  },
};

async function buildStudyList({ candidates, grader }) {
  const prompt = candidates
    .map((c, i) =>
      [
        `--- candidate ${i + 1}`,
        `key: ${c.key}`,
        `made ${c.count}\u00d7${c.missed ? ", and made again after the learner marked it reviewed" : ""}`,
        ...c.examples.flatMap((e) => [
          `example (${LANGS[e.from] ?? "?"} \u2192 ${LANGS[e.to] ?? "?"}):`,
          e.source ? `  source (${LANGS[e.from] ?? "?"}): ${e.source}` : `  source: no longer on record`,
          `  learner wrote: ${e.wrong}`,
          `  correction: ${e.right}`,
          `  why: ${e.explanation}`,
        ]),
      ].join("\n")
    )
    .join("\n\n");

  const params = {
    model: grader.model,
    max_tokens: 8000,
    system: STUDY_SYSTEM,
    output_config: {
      ...(grader.effort && { effort: grader.effort }),
      format: { type: "json_schema", schema: STUDY_SCHEMA },
    },
    messages: [{ role: "user", content: `${candidates.length} candidates:\n\n${prompt}` }],
  };
  const response = await client.messages.create(params);

  if (response.stop_reason === "refusal") throw new Error("The model declined to build a list from these mistakes.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) throw new Error(`No list returned (stop_reason: ${response.stop_reason})`);

  const { items } = unescapeStrings(JSON.parse(text));
  const known = new Set(candidates.map((c) => c.key));
  const seen = new Set();
  return {
    // Keep only items that map back to a candidate, and one item per phrase.
    items: (items ?? []).filter((it) => {
      const phrase = String(it.phrase ?? "").trim();
      if (!phrase || !known.has(it.key) || seen.has(it.key) || seen.has(phrase.toLowerCase())) return false;
      seen.add(it.key).add(phrase.toLowerCase());
      return true;
    }),
    grader: { ...grader, servedBy: response.model },
    usage: costOf(response.model, response.usage),
  };
}

// Models occasionally double-escape non-ASCII inside JSON strings, leaving a literal "\u2014" or "r\u00f6da"
// in the parsed text. Turn those back into characters.
function unescapeStrings(value) {
  if (typeof value === "string") return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (Array.isArray(value)) return value.map(unescapeStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unescapeStrings(v)]));
  return value;
}

// ---------------------------------------------------------------------------
// HTTP

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// Scripts only from this origin and Turnstile, no framing; inline styles stay allowed for a few style="" attributes.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// Cloudflare caches .js and .css for hours whatever the origin says, so the page and scripts refer to
// each asset as name?v=<content hash>: an edited file gets a new URL that no cache has seen yet.
const VERSIONED = ["app.js", "text.js", "style.css"];
async function withVersions(text) {
  for (const name of VERSIONED) {
    const data = await fs.readFile(path.join(PUBLIC, name)).catch(() => null);
    if (!data) continue;
    const v = crypto.createHash("sha256").update(data).digest("hex").slice(0, 10);
    text = text.replace(new RegExp(`(["'](?:\\./)?)${name.replace(".", "\\.")}(["'])`, "g"), `$1${name}?v=${v}$2`);
  }
  return text;
}

function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": `${type}; charset=utf-8`, ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// Sends the access check's error and returns true, or returns false when the request may go ahead.
function denied(res, req, opts) {
  const err = access.check(req, opts);
  if (err) send(res, err.status, err.body);
  return !!err;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Request too large");
  }
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/access") {
      return send(res, 200, {
        gated: access.GATED,
        captcha: access.CAPTCHA_SITE_KEY,
        password: !!process.env.ACCESS_PASSWORD,
        authed: !access.GATED || !!access.sessionOf(req),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      const out = await access.signIn(req, await readJson(req));
      return send(res, out.status, out.body, "application/json", out.cookie ? { "Set-Cookie": out.cookie } : {});
    }

    if (req.method === "GET" && url.pathname === "/api/sentence") {
      if (denied(res, req)) return;
      const from = url.searchParams.get("from") === "eng" ? "eng" : "swe";
      const length = LENGTHS.has(url.searchParams.get("length")) ? url.searchParams.get("length") : "short";
      return send(res, 200, await nextSentence(from, length));
    }

    if (req.method === "GET" && url.pathname === "/api/graders") {
      return send(res, 200, { models: GRADERS, default: DEFAULT_GRADER });
    }

    if (req.method === "POST" && url.pathname === "/api/grade") {
      if (denied(res, req, { rateLimited: true })) return;
      const body = await readJson(req);
      if (!LANGS[body.from] || !LANGS[body.to] || !body.source || !body.attempt?.trim()) {
        return send(res, 400, { error: "Missing fields" });
      }
      const result = await grade({
        from: body.from,
        to: body.to,
        source: String(body.source).slice(0, 2000),
        references: (body.references ?? []).slice(0, 8).map((r) => String(r).slice(0, 2000)),
        attempt: String(body.attempt).slice(0, 2000),
        sourceKind: body.sourceKind,
        grader: body.grader ? resolveGrader(body.grader.model, body.grader.effort) : DEFAULT_GRADER,
      });
      access.charge(result.usage.cost);
      return send(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/studylist") {
      if (denied(res, req, { rateLimited: true })) return;
      const body = await readJson(req);
      const candidates = (body.candidates ?? []).slice(0, 60).map((c) => ({
        key: String(c.key ?? "").slice(0, 120),
        count: Number(c.count) || 1,
        missed: !!c.missed,
        examples: (c.examples ?? []).slice(0, 3).map((e) => ({
          from: LANGS[e.from] ? e.from : undefined,
          to: LANGS[e.to] ? e.to : undefined,
          source: e.source ? String(e.source).slice(0, 600) : null,
          wrong: String(e.wrong ?? "").slice(0, 300),
          right: String(e.right ?? "").slice(0, 300),
          explanation: String(e.explanation ?? "").slice(0, 400),
        })),
      }));
      if (!candidates.length) return send(res, 400, { error: "No candidates" });
      const result = await buildStudyList({
        candidates,
        grader: body.grader ? resolveGrader(body.grader.model, body.grader.effort) : DEFAULT_GRADER,
      });
      access.charge(result.usage.cost);
      return send(res, 200, result);
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
      let data = await fs.readFile(file).catch(() => null);
      if (!data) return send(res, 404, "Not found", "text/plain");
      if (/\.(html|js)$/.test(file)) data = await withVersions(data.toString("utf8"));
      // Revalidate every time: a cached app.js paired with a newer index.html (or the reverse) breaks the page.
      return send(res, 200, data, MIME[path.extname(file)] ?? "application/octet-stream", { "Cache-Control": "no-cache" });
    }

    send(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    const status = err instanceof Anthropic.APIError ? 502 : 500;
    send(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`glosor → http://localhost:${PORT}  (grader: ${DEFAULT_GRADER.model}${DEFAULT_GRADER.effort ? `, effort ${DEFAULT_GRADER.effort}` : ""})`);
  console.log(`access: ${access.describe()}`);
  if (access.GATED && !access.DAILY_BUDGET) console.warn("warning: no DAILY_BUDGET_USD set; spend is only limited per session.");
  if (access.GATED && !process.env.SESSION_SECRET) console.warn("warning: no SESSION_SECRET set; sessions end whenever the server restarts.");
  for (const from of ["swe", "eng"]) refill(`${from}:short`, from, "short").catch((e) => console.error(e.message));
});
