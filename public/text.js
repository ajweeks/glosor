// Text comparison: normalisation, contraction-aware word diff, reference matching.

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1") // quote marks, not apostrophes
    .replace(/\s+/g, " ")
    .trim();

// English contractions expand to their full forms so "I've" ≡ "I have" and "didn't" ≡ "did not".
// Ambiguous ones expand to alternatives: "he'd" = he would|had, "it's" = it is|has.
const IRREGULAR = {
  "can't": ["can", "not"],
  cannot: ["can", "not"],
  "won't": ["will", "not"],
  "shan't": ["shall", "not"],
  "let's": ["let", "us"],
  "y'all": ["you", "all"],
  "ma'am": ["madam"],
};
const S_HOSTS = new Set(["it", "he", "she", "that", "there", "here", "what", "who", "where", "when", "why", "how", "this", "everyone", "everybody", "nobody", "someone", "somebody", "nothing", "something", "everything"]);

// A token is a string, or an array of acceptable alternatives.
function expandWord(w) {
  if (IRREGULAR[w]) return IRREGULAR[w];
  let m;
  if ((m = w.match(/^(\w+)n't$/))) return [m[1], "not"];
  if ((m = w.match(/^(\w+)'re$/))) return [m[1], "are"];
  if ((m = w.match(/^(\w+)'ve$/))) return [m[1], "have"];
  if ((m = w.match(/^(\w+)'ll$/))) return [m[1], "will"];
  if ((m = w.match(/^(i)'m$/))) return [m[1], "am"];
  if ((m = w.match(/^(\w+)'d$/))) return [m[1], ["would", "had"]];
  if ((m = w.match(/^(\w+)'s$/)) && S_HOSTS.has(m[1])) return [m[1], ["is", "has"]];
  return [w];
}

function keysFor(displayToken) {
  const n = norm(displayToken);
  if (!n) return [];
  return n.split(" ").flatMap(expandWord);
}

const eq = (a, b) =>
  typeof a === "string" && typeof b === "string" ? a === b
  : typeof a === "string" ? b.includes(a)
  : typeof b === "string" ? a.includes(b)
  : a.some((x) => b.includes(x));

function tokenize(s) {
  const display = String(s).trim().split(/\s+/).filter(Boolean);
  const keys = [];
  const owner = [];
  display.forEach((t, i) => {
    for (const k of keysFor(t)) {
      keys.push(k);
      owner.push(i);
    }
  });
  return { display, keys, owner };
}

// Contraction-aware word LCS. Each display token on either side gets a state:
//   "same"  – matched word for word
//   "equiv" – matched only through a contraction ("didn't" ↔ "did not")
//   "diff"  – no counterpart on the other side
export function diffWords(attempt, reference) {
  const A = tokenize(attempt), B = tokenize(reference);
  const n = A.keys.length, m = B.keys.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = eq(A.keys[i], B.keys[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const aState = new Array(n).fill("diff"), bState = new Array(m).fill("diff");
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (eq(A.keys[i], B.keys[j])) {
      const surface = norm(A.display[A.owner[i]]) === norm(B.display[B.owner[j]]);
      aState[i++] = bState[j++] = surface ? "same" : "equiv";
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }

  // A display token takes the worst state of the keys it expanded to.
  const RANK = { same: 0, equiv: 1, diff: 2 };
  const side = (T, states) => {
    const out = T.display.map(() => "same");
    T.owner.forEach((d, k) => { if (RANK[states[k]] > RANK[out[d]]) out[d] = states[k]; });
    return T.display.map((text, i) => ({ text, state: out[i] }));
  };
  const matched = dp[0][0];
  const yours = side(A, aState), theirs = side(B, bState);
  return {
    yours,
    theirs,
    equivalent: matched === n && matched === m,
    exact: matched === n && matched === m && !yours.some((t) => t.state === "equiv"),
    similarity: (2 * matched) / (n + m || 1),
  };
}

export function closestReference(attempt, references) {
  let best = null;
  for (const ref of references) {
    const d = diffWords(attempt, ref.text);
    if (!best || d.similarity > best.similarity) best = { ...d, ref };
  }
  return best;
}
