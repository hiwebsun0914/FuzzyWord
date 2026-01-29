const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DEFAULT_DICT_PATH = path.join(ROOT_DIR, "data", "merged_dictionary.json");
const DICT_PATH = (() => {
  const override = (process.env.DICT_PATH || "").trim();
  if (!override) return DEFAULT_DICT_PATH;
  return path.isAbsolute(override) ? override : path.join(ROOT_DIR, override);
})();
const NGRAM_N = 3;
const MAX_CANDIDATES = 400;

const DEFAULT_QWEN_MODEL_PATH = path.join(ROOT_DIR, "models", "Qwen3-1.7B");
const QWEN_MODEL_PATH = (() => {
  const override = (process.env.QWEN_MODEL_PATH || "").trim();
  const value = override || DEFAULT_QWEN_MODEL_PATH;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
})();
const QWEN_PYTHON = (process.env.QWEN_PYTHON || process.env.PYTHON || "python").trim();
const QWEN_WORKER = path.join(ROOT_DIR, "tools", "qwen_worker.py");
const QWEN_DOWNLOADER = path.join(ROOT_DIR, "tools", "download_qwen_model.py");
const QWEN_STARTUP_TIMEOUT_MS = Number(process.env.QWEN_STARTUP_TIMEOUT_MS || "600000"); // 10 min
const QWEN_REQUEST_TIMEOUT_MS = Number(process.env.QWEN_REQUEST_TIMEOUT_MS || "60000"); // 60 sec
const QWEN_CACHE_MAX = Number(process.env.QWEN_CACHE_MAX || "300");
const DEFAULT_QWEN_CACHE_PATH = path.join(ROOT_DIR, "data", "qwen_cache.jsonl");
const QWEN_CACHE_PATH = (() => {
  const override = (process.env.QWEN_CACHE_PATH || "").trim();
  if (!override) return DEFAULT_QWEN_CACHE_PATH;
  return path.isAbsolute(override) ? override : path.join(ROOT_DIR, override);
})();
const QWEN_LIVE_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.QWEN_LIVE || "").trim()
);
const QWEN_AUTO_DOWNLOAD = !/^(0|false|no)$/i.test(
  String(process.env.QWEN_AUTO_DOWNLOAD || "").trim() || "1"
);
const DEFAULT_HF_HOME = path.join(ROOT_DIR, ".hf");

const LOW_COST_SUB_PAIRS = [
  ["i", "l"],
  ["l", "t"],
  ["m", "n"],
  ["v", "w"],
  ["c", "k"],
  ["c", "s"],
  ["p", "b"],
  ["a", "e"],
  ["o", "u"],
  ["q", "g"],
];

const KEYBOARD_NEIGHBORS = {
  q: "was",
  w: "qesad",
  e: "wsdrf",
  r: "etdfg",
  t: "ryfgh",
  y: "tughj",
  u: "yihjk",
  i: "uojkl",
  o: "ipkl;",
  p: "ol;['",
  a: "qwsz",
  s: "qweadzx",
  d: "wersfxc",
  f: "ertdgcv",
  g: "rtyfhvb",
  h: "tyugjbn",
  j: "yuikhbnm",
  k: "uioljmn",
  l: "iopk;nm",
  z: "asx",
  x: "zsdc",
  c: "xdfv",
  v: "cfgb",
  b: "vghn",
  n: "bhjm",
  m: "njk",
};

const CONFUSION_SUFFIX_RULES = [
  { name: "ie/ei swap", variants: ["ie", "ei"] },
  { name: "-tion/-sion/-cion", variants: ["tion", "sion", "cion"] },
  { name: "-able/-ible", variants: ["able", "ible"] },
  { name: "-ance/-ence", variants: ["ance", "ence"] },
  { name: "-ary/-ery/-ory", variants: ["ary", "ery", "ory"] },
  { name: "ph/f", variants: ["ph", "f"] },
  { name: "ck/k", variants: ["ck", "k"] },
];

const STRONG_CONFUSION_PAIRS = [
  ["affect", "effect"],
  ["compliment", "complement"],
  ["principal", "principle"],
  ["precede", "proceed"],
  ["accept", "except"],
  ["desert", "dessert"],
  ["advice", "advise"],
  ["stationary", "stationery"],
  ["access", "excess"],
  ["angel", "angle"],
  ["loose", "lose"],
  ["than", "then"],
];

function log(...args) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}]`, ...args);
}

function normalizeEntry(raw) {
  if (!raw || !raw.word) return null;

  const word = String(raw.word).trim();
  if (!word) return null;

  const posSet = new Set();
  const cnSet = new Set();

  if (Array.isArray(raw.translations)) {
    for (const item of raw.translations) {
      if (!item) continue;
      const translation =
        typeof item.translation === "string"
          ? item.translation.trim()
          : String(item.translation || "").trim();
      const type =
        typeof item.type === "string"
          ? item.type.trim().replace(/\s+/g, "")
          : "";

      if (translation) cnSet.add(translation);
      if (type) posSet.add(type);
    }
  } else {
    const pos = typeof raw.pos === "string" ? raw.pos.trim() : "";
    const cn = typeof raw.cn === "string" ? raw.cn.trim() : "";
    if (pos) posSet.add(pos.replace(/\s+/g, ""));
    if (cn) cnSet.add(cn);
  }

  const pos = Array.from(posSet).join("/") || "";
  const cn = Array.from(cnSet).join("; ");
  const freq =
    raw.freq !== undefined && raw.freq !== null
      ? Number(raw.freq) || 0
      : 0;

  return {
    word,
    pos,
    cn,
    freq,
    wordLower: word.toLowerCase(),
    len: word.length,
  };
}

function loadDictionary() {
  try {
    const raw = fs.readFileSync(DICT_PATH, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) {
      throw new Error("Dictionary file must be an array");
    }

    const dict = list.map(normalizeEntry).filter(Boolean);

    log(
      `Loaded ${dict.length} entries from ${path.relative(
        ROOT_DIR,
        DICT_PATH
      )}`
    );
    return dict;
  } catch (err) {
    log("Failed to load dictionary from data/merged_dictionary.json:", err);
    process.exit(1);
  }
}

const dictionary = loadDictionary();
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const lowCostSubMap = new Set(LOW_COST_SUB_PAIRS.map(([a, b]) => pairKey(a, b)));
const keyboardNeighborMap = new Map(
  Object.entries(KEYBOARD_NEIGHBORS).map(([k, v]) => [k, new Set(v.split(""))])
);
const vowels = new Set(["a", "e", "i", "o", "u"]);
const wordToIndex = new Map();

function getNgrams(word, n) {
  if (!word) return new Set();
  if (word.length <= n) return new Set([word]);
  const grams = new Set();
  for (let i = 0; i <= word.length - n; i++) {
    grams.add(word.slice(i, i + n));
  }
  return grams;
}

function buildNgramIndex(dict, n) {
  const index = new Map();
  dict.forEach((entry, idx) => {
    entry[`n${n}grams`] = getNgrams(entry.wordLower, n);
    entry.len = entry.wordLower.length;
    wordToIndex.set(entry.wordLower, idx);
    for (const gram of entry[`n${n}grams`]) {
      if (!index.has(gram)) index.set(gram, []);
      index.get(gram).push(idx);
    }
  });
  return index;
}

function buildConfusionMap(pairs) {
  const map = new Map();
  for (const [a, b] of pairs) {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (!wordToIndex.has(la) || !wordToIndex.has(lb)) continue;
    if (!map.has(la)) map.set(la, new Set());
    if (!map.has(lb)) map.set(lb, new Set());
    map.get(la).add(lb);
    map.get(lb).add(la);
  }
  return map;
}

const ngramIndex = buildNgramIndex(dictionary, NGRAM_N);
const strongConfusionMap = buildConfusionMap(STRONG_CONFUSION_PAIRS);

function isValidWord(word) {
  return (
    typeof word === "string" &&
    /^[a-zA-Z]+$/.test(word) &&
    word.length >= 1 &&
    word.length <= 30
  );
}

function substitutionCost(a, b) {
  if (a === b) return { cost: 0, reason: "match" };
  const key = pairKey(a, b);
  if (lowCostSubMap.has(key)) {
    return { cost: 0.35, reason: "visual similarity", tag: "visual" };
  }
  if (keyboardNeighborMap.get(a)?.has(b)) {
    return { cost: 0.55, reason: "keyboard neighbor", tag: "keyboard" };
  }
  if (vowels.has(a) && vowels.has(b)) {
    return { cost: 0.65, reason: "vowel swap", tag: "vowel" };
  }
  return { cost: 1, reason: "substitution" };
}

function transposeCost() {
  return 0.7;
}

function damerauLevenshteinDetailed(source, target) {
  const a = source.toLowerCase();
  const b = target.toLowerCase();
  const m = a.length;
  const n = b.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  const parent = Array.from({ length: m + 1 }, () => Array(n + 1).fill(null));

  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
    if (i > 0) parent[i][0] = { i: i - 1, j: 0, op: "delete" };
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
    if (j > 0) parent[0][j] = { i: 0, j: j - 1, op: "insert" };
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const subInfo = substitutionCost(a[i - 1], b[j - 1]);
      let best = dp[i - 1][j - 1] + subInfo.cost;
      let bestParent = {
        i: i - 1,
        j: j - 1,
        op: subInfo.cost === 0 ? "match" : "replace",
        info: subInfo,
      };

      const del = dp[i - 1][j] + 1;
      if (del < best) {
        best = del;
        bestParent = { i: i - 1, j, op: "delete" };
      }
      const ins = dp[i][j - 1] + 1;
      if (ins < best) {
        best = ins;
        bestParent = { i, j: j - 1, op: "insert" };
      }
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const trans = dp[i - 2][j - 2] + transposeCost();
        if (trans < best) {
          best = trans;
          bestParent = {
            i: i - 2,
            j: j - 2,
            op: "transpose",
            info: { chars: [a[i - 2], a[i - 1]] },
          };
        }
      }

      dp[i][j] = best;
      parent[i][j] = bestParent;
    }
  }

  const operations = [];
  let rawEdits = 0;
  let keyboardHits = 0;
  let vowelSwaps = 0;
  let visualHits = 0;
  let transpositions = 0;

  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const step = parent[i][j];
    if (!step) break;
    const { op, i: pi, j: pj } = step;

    if (op === "match") {
      i = pi;
      j = pj;
      continue;
    }

    if (op === "replace") {
      rawEdits += 1;
      const reason = step.info?.reason;
      if (step.info?.tag === "keyboard") keyboardHits += 1;
      if (step.info?.tag === "vowel") vowelSwaps += 1;
      if (step.info?.tag === "visual") visualHits += 1;
      const note = reason ? ` (${reason})` : "";
      operations.push(
        `pos ${pi + 1}: replace '${a[pi]}' -> '${b[pj]}'${note}`
      );
    } else if (op === "delete") {
      rawEdits += 1;
      operations.push(`pos ${pi + 1}: delete '${a[pi]}'`);
    } else if (op === "insert") {
      rawEdits += 1;
      const inserted = b[j - 1] || "";
      operations.push(`pos ${pi + 1}: insert '${inserted}'`);
    } else if (op === "transpose") {
      rawEdits += 1;
      transpositions += 1;
      const left = pi + 1;
      const right = pi + 2;
      operations.push(
        `swap pos ${left}-${right}: '${a[pi]}${a[pi + 1]}' -> '${b[j - 2]}${b[j - 1]}'`
      );
    }
    i = pi;
    j = pj;
  }

  operations.reverse();
  return {
    distance: dp[m][n],
    operations,
    rawEdits,
    keyboardHits,
    vowelSwaps,
    visualHits,
    transpositions,
  };
}

function ngramSimilarity(aSet, bSet) {
  if (!aSet || !bSet) return 0;
  let overlap = 0;
  for (const g of aSet) {
    if (bSet.has(g)) overlap += 1;
  }
  const union = aSet.size + bSet.size - overlap;
  if (union === 0) return 0;
  return overlap / union;
}

function commonAffixScore(a, b) {
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const maxLen = Math.max(a.length, b.length) || 1;
  return (prefix + suffix) / (maxLen * 1.2);
}

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

function getRuleVariants(wordLower) {
  const variants = [];
  for (const rule of CONFUSION_SUFFIX_RULES) {
    for (const from of rule.variants) {
      if (!wordLower.endsWith(from)) continue;
      const stem = wordLower.slice(0, wordLower.length - from.length);
      for (const to of rule.variants) {
        if (to === from) continue;
        variants.push({ variant: `${stem}${to}`, rule: rule.name });
      }
    }
  }
  return variants;
}

function detectRuleHits(a, b) {
  const hits = new Set();
  for (const rule of CONFUSION_SUFFIX_RULES) {
    for (const x of rule.variants) {
      if (!a.endsWith(x)) continue;
      const stem = a.slice(0, a.length - x.length);
      for (const y of rule.variants) {
        if (x === y) continue;
        if (b === `${stem}${y}` || b.endsWith(y)) {
          hits.add(`${rule.name}: ${x} -> ${y}`);
        }
      }
    }
  }
  const squash = (str) => str.replace(/(.)\1+/g, "$1");
  if (squash(a) === squash(b) && a !== b) {
    hits.add("double-letter add/drop");
  }
  return Array.from(hits);
}

function collectNgramCandidates(queryNgrams) {
  const counter = new Map();
  for (const gram of queryNgrams) {
    const postings = ngramIndex.get(gram);
    if (!postings) continue;
    for (const idx of postings) {
      counter.set(idx, (counter.get(idx) || 0) + 1);
    }
  }
  return counter;
}

function scoreCandidate(queryLower, entry, queryNgrams, forcedRuleHits = []) {
  const edit = damerauLevenshteinDetailed(queryLower, entry.wordLower);
  const maxLen = Math.max(entry.len, queryLower.length, 4);
  const editSim = 1 - Math.min(edit.distance, maxLen) / maxLen;
  const ngramSim = ngramSimilarity(queryNgrams, entry.n3grams || new Set());
  const affixSim = commonAffixScore(queryLower, entry.wordLower);

  const ruleHits = [...forcedRuleHits, ...detectRuleHits(queryLower, entry.wordLower)];
  const keyboardBonus = Math.min(edit.keyboardHits * 0.03, 0.12);
  const ruleBonus = Math.min(ruleHits.length * 0.08 + keyboardBonus, 0.32);
  const freqBoost = entry.freq
    ? Math.min(Math.log10(entry.freq + 1) * 0.02, 0.08)
    : 0;
  const lengthPenalty = Math.max(
    0,
    (Math.abs(entry.len - queryLower.length) - 2) * 0.02
  );

  const score =
    editSim * 0.5 +
    ngramSim * 0.2 +
    affixSim * 0.1 +
    ruleBonus * 0.15 +
    freqBoost * 0.05 -
    lengthPenalty;

  return {
    score: clamp(score, 0, 1),
    editSim,
    ngramSim,
    affixSim,
    ruleBonus,
    freqBoost,
    lengthPenalty,
    edit,
    ruleHits,
  };
}

function searchSimilar(word, topK = 5) {
  const normalized = word.toLowerCase();
  const queryNgrams = getNgrams(normalized, NGRAM_N);
  const ngramCandidates = collectNgramCandidates(queryNgrams);
  const sortedByOverlap = Array.from(ngramCandidates.entries()).sort(
    (a, b) => b[1] - a[1]
  );

  const candidateSet = new Set(
    sortedByOverlap.slice(0, MAX_CANDIDATES).map(([idx]) => idx)
  );

  const forcedRuleHits = new Map();
  for (const variant of getRuleVariants(normalized)) {
    const idx = wordToIndex.get(variant.variant);
    if (idx !== undefined) {
      candidateSet.add(idx);
      if (!forcedRuleHits.has(idx)) forcedRuleHits.set(idx, []);
      forcedRuleHits.get(idx).push(`rule variant: ${variant.rule}`);
    }
  }

  const pairHits = strongConfusionMap.get(normalized);
  if (pairHits) {
    for (const other of pairHits) {
      const idx = wordToIndex.get(other);
      if (idx !== undefined) {
        candidateSet.add(idx);
        if (!forcedRuleHits.has(idx)) forcedRuleHits.set(idx, []);
        forcedRuleHits.get(idx).push("strong confusion pair");
      }
    }
  }

  const scored = [];
  for (const idx of candidateSet) {
    const entry = dictionary[idx];
    if (!entry || entry.wordLower === normalized) continue;
    const forcedHits = forcedRuleHits.get(idx) || [];
    const details = scoreCandidate(normalized, entry, queryNgrams, forcedHits);
    scored.push({
      entry,
      lengthDiff: Math.abs(entry.len - normalized.length),
      ...details,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.edit.distance !== b.edit.distance)
      return a.edit.distance - b.edit.distance;
    if (a.lengthDiff !== b.lengthDiff) return a.lengthDiff - b.lengthDiff;
    if ((b.entry.freq || 0) !== (a.entry.freq || 0))
      return (b.entry.freq || 0) - (a.entry.freq || 0);
    return a.entry.word.localeCompare(b.entry.word);
  });

  return scored.slice(0, topK).map((item) => ({
    word: item.entry.word,
    pos: item.entry.pos,
    meaning: item.entry.cn,
    score: Number(item.score.toFixed(4)),
    distance: Number(item.edit.distance.toFixed(3)),
    lengthDiff: item.lengthDiff,
    freq: item.entry.freq || 0,
    ngramScore: Number(item.ngramSim.toFixed(3)),
    ruleHits: item.ruleHits,
    diffSteps: item.edit.operations,
    signals: {
      editSim: Number(item.editSim.toFixed(3)),
      affixSim: Number(item.affixSim.toFixed(3)),
      ruleBonus: Number(item.ruleBonus.toFixed(3)),
      lengthPenalty: Number(item.lengthPenalty?.toFixed(3) || 0),
      keyboardHits: item.edit.keyboardHits,
      vowelSwaps: item.edit.vowelSwaps,
      transpositions: item.edit.transpositions,
    },
  }));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function extractJsonFromText(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

let qwenClientPromise = null;
let qwenCache = new Map(); // wordLower -> payload
let qwenDiskCachePromise = null; // Promise<Map>

async function loadQwenDiskCache() {
  const map = new Map();
  try {
    if (!QWEN_CACHE_PATH || !fs.existsSync(QWEN_CACHE_PATH)) {
      log(
        `Qwen cache file not found (ok): ${path.relative(
          ROOT_DIR,
          QWEN_CACHE_PATH
        )}`
      );
      return map;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(QWEN_CACHE_PATH, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const s = (line || "").trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (!obj || obj.ok !== true) continue;
        const w = String(obj.word || "").trim().toLowerCase();
        if (!w) continue;
        if (!obj.data || typeof obj.data !== "object") continue;
        map.set(w, obj.data);
      } catch {
        // ignore bad lines
      }
    }

    log(
      `Loaded Qwen disk cache ${map.size} entries from ${path.relative(
        ROOT_DIR,
        QWEN_CACHE_PATH
      )}`
    );
    return map;
  } catch (err) {
    log("Failed to load Qwen cache file:", err?.message || err);
    return map;
  }
}

function getQwenDiskCachePromise() {
  if (!qwenDiskCachePromise) {
    qwenDiskCachePromise = loadQwenDiskCache();
  }
  return qwenDiskCachePromise;
}

function pruneQwenCache() {
  if (qwenCache.size <= QWEN_CACHE_MAX) return;
  const keep = QWEN_CACHE_MAX;
  const entries = Array.from(qwenCache.entries());
  qwenCache = new Map(entries.slice(entries.length - keep));
}

function startQwenWorker() {
  if (qwenClientPromise) return qwenClientPromise;

  qwenClientPromise = new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      qwenClientPromise = null;
      reject(err);
    };

    (async () => {
      if (!fs.existsSync(QWEN_WORKER)) {
        safeReject(new Error(`Missing worker: ${QWEN_WORKER}`));
        return;
      }

      if (!QWEN_MODEL_PATH) {
        safeReject(new Error("QWEN_MODEL_PATH is empty"));
        return;
      }

      const configPath = path.join(QWEN_MODEL_PATH, "config.json");
      if (!fs.existsSync(configPath)) {
        if (!QWEN_AUTO_DOWNLOAD) {
          safeReject(
            new Error(
              `Qwen model not found at ${QWEN_MODEL_PATH}. Set QWEN_MODEL_PATH or enable auto-download (QWEN_AUTO_DOWNLOAD=1).`
            )
          );
          return;
        }

        if (!fs.existsSync(QWEN_DOWNLOADER)) {
          safeReject(new Error(`Missing downloader: ${QWEN_DOWNLOADER}`));
          return;
        }

        log(`Qwen model missing. Auto-downloading to: ${QWEN_MODEL_PATH}`);
        const dl = spawn(QWEN_PYTHON, [QWEN_DOWNLOADER, "--repo", "Qwen/Qwen3-1.7B", "--out", QWEN_MODEL_PATH], {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            HF_HOME: process.env.HF_HOME || DEFAULT_HF_HOME,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        dl.stdout.setEncoding("utf8");
        dl.stdout.on("data", (chunk) => {
          const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
          for (const line of lines) log(`[QWEN-DL] ${line}`);
        });
        dl.stderr.setEncoding("utf8");
        dl.stderr.on("data", (chunk) => {
          const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
          for (const line of lines) log(`[QWEN-DL] ${line}`);
        });

        const dlOk = await new Promise((r) => dl.on("exit", (code) => r(code === 0)));
        if (!dlOk || !fs.existsSync(configPath)) {
          safeReject(new Error("Auto-download failed (model config.json still missing)"));
          return;
        }
      }

      const proc = spawn(QWEN_PYTHON, [QWEN_WORKER], {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          QWEN_MODEL_PATH,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const pending = new Map(); // id -> {resolve,reject,timeout}
      let nextId = 1;
      let stdoutBuf = "";

      const failAll = (err) => {
        for (const [, p] of pending) {
          clearTimeout(p.timeout);
          p.reject(err);
        }
        pending.clear();
      };

      proc.on("error", (err) => {
        failAll(err);
        safeReject(err);
      });

      proc.on("exit", (code, signal) => {
        qwenClientPromise = null;
        const err = new Error(
          `Qwen worker exited (code=${code}, signal=${signal || "none"})`
        );
        failAll(err);
        safeReject(err);
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => {
        const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          log(`[QWEN] ${line}`);
        }
      });

      let ready = false;
      const readyTimer = setTimeout(() => {
        if (ready) return;
        try {
          proc.kill();
        } catch {
          // ignore
        }
        safeReject(new Error("Qwen worker startup timeout"));
      }, QWEN_STARTUP_TIMEOUT_MS);

      const client = {
        request(payload) {
          if (!proc.stdin.writable) {
            return Promise.reject(new Error("Qwen worker stdin is not writable"));
          }
          const id = String(nextId++);
          const message = JSON.stringify({ id, ...payload }) + "\n";
          return new Promise((resolveReq, rejectReq) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              rejectReq(new Error("Qwen request timeout"));
            }, QWEN_REQUEST_TIMEOUT_MS);
            pending.set(id, { resolve: resolveReq, reject: rejectReq, timeout });
            proc.stdin.write(message, "utf8");
          });
        },
      };

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === "ready") {
            ready = true;
            clearTimeout(readyTimer);
            safeResolve(client);
            continue;
          }
          if (msg && msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            clearTimeout(p.timeout);
            if (msg.ok) p.resolve(msg);
            else p.reject(new Error(msg.error || "Qwen worker error"));
          }
        }
      });
    })().catch((err) => safeReject(err));
  });

  return qwenClientPromise;
}

async function expandWithQwen(word) {
  const key = String(word || "").trim().toLowerCase();
  if (!key) return { ok: false, error: "Empty word" };

  if (qwenCache.has(key)) {
    return { ok: true, data: qwenCache.get(key), cached: true };
  }

  try {
    const client = await startQwenWorker();
    const t0 = Date.now();
    const msg = await client.request({ word: key });
    const tookMs = Date.now() - t0;

    const rawText = typeof msg.text === "string" ? msg.text : "";
    const parsed = extractJsonFromText(rawText);
    const data =
      parsed && typeof parsed === "object"
        ? { ...parsed, rawText }
        : { rawText };

    const final = {
      ...data,
      _meta: {
        provider: "qwen3-local",
        modelPath: path.relative(ROOT_DIR, QWEN_MODEL_PATH),
        tookMs,
        cached: false,
      },
    };

    qwenCache.set(key, final);
    pruneQwenCache();

    return { ok: true, data: final, cached: false };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}

function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };
    const type = map[ext] || "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  const word =
    (url.searchParams.get("word") ||
      url.searchParams.get("q") ||
      "").trim();
  const k = parseInt(url.searchParams.get("k") || "7", 10);
  const topK = Number.isFinite(k) ? Math.min(Math.max(k, 1), 20) : 7;

  if (pathname === "/api/search") {
    if (!isValidWord(word)) {
      sendJson(res, 400, {
        error: "输入不合法：请输入单个英文单词（a-zA-Z，长度 1-30）。",
        query: word,
      });
      return;
    }

    const results = searchSimilar(word, topK);
    sendJson(res, 200, {
      query: word.toLowerCase(),
      topK,
      results,
      meta: {
        algorithm:
          "Damerau-Levenshtein (weighted) + n-gram recall + exam confusion rules",
        sortOrder: "score DESC, distance ASC, length difference ASC, freq DESC",
        dictionarySize: dictionary.length,
        ngram: `n=${NGRAM_N}, maxCandidates=${MAX_CANDIDATES}`,
        generatedAt: new Date().toISOString(),
      },
    });
    return;
  }

  if (pathname === "/api/expand") {
    if (!isValidWord(word)) {
      sendJson(res, 400, {
        error: "输入不合法：请输入单个英文单词（a-zA-Z，长度 1-30）。",
        query: word,
      });
      return;
    }

    const similar = {
      topK,
      results: searchSimilar(word, topK),
      meta: {
        algorithm:
          "Damerau-Levenshtein (weighted) + n-gram recall + exam confusion rules",
        sortOrder: "score DESC, distance ASC, length difference ASC, freq DESC",
        dictionarySize: dictionary.length,
        ngram: `n=${NGRAM_N}, maxCandidates=${MAX_CANDIDATES}`,
      },
    };

    const cache = await getQwenDiskCachePromise();
    const key = word.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      sendJson(res, 200, {
        query: key,
        similar,
        expand: {
          ok: true,
          data: {
            ...cached,
            _meta: {
              ...(cached._meta || {}),
              provider: "qwen3-local",
              source: "disk-cache",
              cachePath: path.relative(ROOT_DIR, QWEN_CACHE_PATH),
            },
          },
          cached: true,
        },
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (!QWEN_LIVE_ENABLED) {
      sendJson(res, 200, {
        query: key,
        similar,
        expand: {
          ok: false,
          error:
            "未命中本地缓存，且已关闭实时调用（QWEN_LIVE=0）。请先运行 tools/precompute_qwen_cache.js 生成缓存，或设置 QWEN_LIVE=1。",
        },
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    const expand = await expandWithQwen(word);
    sendJson(res, 200, {
      query: key,
      similar,
      expand,
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  if (pathname === "/api/llm") {
    if (!isValidWord(word)) {
      sendJson(res, 400, {
        error: "输入不合法：请输入单个英文单词（a-zA-Z，长度 1-30）。",
        query: word,
      });
      return;
    }
    const cache = await getQwenDiskCachePromise();
    const key = word.toLowerCase();
    const cached = cache.get(key);
    if (!cached) {
      sendJson(res, 404, {
        query: key,
        ok: false,
        error:
          "未找到该词的离线大模型结果。请运行 tools/precompute_qwen_cache.js 生成缓存。",
      });
      return;
    }
    sendJson(res, 200, {
      query: key,
      ok: true,
      data: cached,
      meta: {
        source: "disk-cache",
        cachePath: path.relative(ROOT_DIR, QWEN_CACHE_PATH),
      },
    });
    return;
  }

  if (pathname === "/api/cache/status") {
    const cache = await getQwenDiskCachePromise();
    sendJson(res, 200, {
      ok: true,
      cachePath: path.relative(ROOT_DIR, QWEN_CACHE_PATH),
      exists: fs.existsSync(QWEN_CACHE_PATH),
      size: cache.size,
      liveEnabled: QWEN_LIVE_ENABLED,
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

function createServer() {
  return http.createServer((req, res) => {
    log(`${req.method} ${req.url}`);
    if (req.url.startsWith("/api/")) {
      handleApi(req, res).catch((err) => {
        log("API error:", err);
        sendJson(res, 500, { error: "Internal server error" });
      });
      return;
    }

    serveStatic(req, res);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    log(`Server listening on http://localhost:${PORT}`);
    log(`Dictionary size: ${dictionary.length}`);
  });
}

module.exports = { createServer };
