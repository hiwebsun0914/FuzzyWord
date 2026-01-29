// Precompute Qwen expansions for all words in the dictionary and store as JSONL.
// Usage:
//   node tools/precompute_qwen_cache.js --dict data/merged_dictionary.json --out data/qwen_cache.jsonl
//
// Env:
//   QWEN_MODEL_PATH (default: models/Qwen3-1.7B)
//   QWEN_PYTHON (default: python)
//   LIMIT (optional number)
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const ROOT_DIR = path.join(__dirname, "..");
const DEFAULT_DICT = path.join(ROOT_DIR, "data", "merged_dictionary.json");
const DEFAULT_OUT = path.join(ROOT_DIR, "data", "qwen_cache.jsonl");
const DEFAULT_MODEL_PATH = path.join(ROOT_DIR, "models", "Qwen3-1.7B");
const MODEL_PATH = (() => {
  const override = (process.env.QWEN_MODEL_PATH || "").trim();
  const value = override || DEFAULT_MODEL_PATH;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
})();
const PYTHON = (process.env.QWEN_PYTHON || process.env.PYTHON || "python").trim();
const WORKER = path.join(ROOT_DIR, "tools", "qwen_worker.py");
const DOWNLOADER = path.join(ROOT_DIR, "tools", "download_qwen_model.py");
const LIMIT = Number(process.env.LIMIT || "0");
const HF_HOME = process.env.HF_HOME || path.join(ROOT_DIR, ".hf");

function parseArgs(argv) {
  const out = { dict: DEFAULT_DICT, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dict") out.dict = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function log(...args) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}]`, ...args);
}

function isValidWord(word) {
  return typeof word === "string" && /^[a-zA-Z]+$/.test(word) && word.length >= 1 && word.length <= 30;
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

async function readJsonlWords(filePath) {
  const set = new Set();
  if (!fs.existsSync(filePath)) return set;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const s = (line || "").trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      const w = String(obj.word || "").trim().toLowerCase();
      if (w) set.add(w);
    } catch {
      // ignore bad lines
    }
  }
  return set;
}

function loadDictionaryWords(dictPath) {
  const abs = path.isAbsolute(dictPath) ? dictPath : path.join(ROOT_DIR, dictPath);
  const raw = fs.readFileSync(abs, "utf8");
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("Dictionary file must be an array");
  const words = [];
  for (const item of list) {
    const w = String(item?.word || "").trim();
    if (!isValidWord(w)) continue;
    words.push(w.toLowerCase());
  }
  return Array.from(new Set(words)).sort();
}

function startWorker() {
  if (!fs.existsSync(WORKER)) throw new Error(`Missing worker: ${WORKER}`);
  if (!MODEL_PATH) throw new Error("QWEN_MODEL_PATH is empty");
  if (!fs.existsSync(MODEL_PATH)) throw new Error(`Model path not found: ${MODEL_PATH}`);

  const proc = spawn(PYTHON, [WORKER], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      QWEN_MODEL_PATH: MODEL_PATH,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
    for (const line of lines) log(`[QWEN] ${line}`);
  });

  let stdoutBuf = "";
  const pending = new Map();
  let nextId = 1;
  let ready = false;

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
        continue;
      }
      if (msg && msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error || "worker error"));
      }
    }
  });

  proc.on("exit", (code, signal) => {
    const err = new Error(`worker exited (code=${code}, signal=${signal || "none"})`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  const request = (word) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++);
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, word }) + "\n", "utf8");
    });

  return { proc, request, isReady: () => ready };
}

function spawnAndWait(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, windowsHide: true });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function ensureModel() {
  if (fs.existsSync(path.join(MODEL_PATH, "config.json"))) return;
  if (!fs.existsSync(DOWNLOADER)) {
    throw new Error(`Missing downloader: ${DOWNLOADER}`);
  }
  log(`Model not found. Auto-downloading to: ${MODEL_PATH}`);
  await spawnAndWait(
    PYTHON,
    [DOWNLOADER, "--repo", "Qwen/Qwen3-1.7B", "--out", MODEL_PATH],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        HF_HOME,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdio: "inherit",
    }
  );
  if (!fs.existsSync(path.join(MODEL_PATH, "config.json"))) {
    throw new Error("Model download finished but config.json is still missing");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/precompute_qwen_cache.js --dict <path> --out <path>");
    process.exit(0);
  }

  const dictPath = args.dict;
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(ROOT_DIR, args.out);

  log("Dictionary:", dictPath);
  log("Output:", outPath);
  log("Model:", path.relative(ROOT_DIR, MODEL_PATH));
  log("Python:", PYTHON);

  const words = loadDictionaryWords(dictPath);
  const done = await readJsonlWords(outPath);

  const todo = words.filter((w) => !done.has(w));
  const effectiveTodo = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;

  log(`Total valid words: ${words.length}`);
  log(`Already cached: ${done.size}`);
  log(`To compute: ${effectiveTodo.length}`);

  if (effectiveTodo.length === 0) {
    log("Nothing to do.");
    return;
  }

  await ensureModel();

  const outStream = fs.createWriteStream(outPath, { flags: "a" });
  const { proc, request, isReady } = startWorker();

  const waitReady = async (timeoutMs = 10 * 60 * 1000) => {
    const start = Date.now();
    while (!isReady()) {
      await new Promise((r) => setTimeout(r, 200));
      if (Date.now() - start > timeoutMs) throw new Error("worker startup timeout");
    }
  };

  process.on("SIGINT", () => {
    try {
      outStream.end();
    } catch {}
    try {
      proc.kill();
    } catch {}
    process.exit(130);
  });

  await waitReady();
  log("Worker ready. Start generating…");

  let okCount = 0;
  let failCount = 0;
  const tAll = Date.now();

  for (let i = 0; i < effectiveTodo.length; i++) {
    const w = effectiveTodo[i];
    const t0 = Date.now();
    try {
      const msg = await request(w);
      const tookMs = Date.now() - t0;
      const rawText = typeof msg.text === "string" ? msg.text : "";
      const parsed = extractJsonFromText(rawText);
      const data =
        parsed && typeof parsed === "object"
          ? { ...parsed, rawText }
          : { rawText };

      outStream.write(
        JSON.stringify({
          word: w,
          ok: true,
          data,
          generatedAt: new Date().toISOString(),
          meta: { modelPath: path.relative(ROOT_DIR, MODEL_PATH), tookMs },
        }) + "\n"
      );
      okCount += 1;
      if ((i + 1) % 20 === 0) {
        const elapsed = ((Date.now() - tAll) / 1000).toFixed(1);
        log(`Progress ${i + 1}/${effectiveTodo.length} (ok=${okCount}, fail=${failCount}) elapsed=${elapsed}s last=${w} ${tookMs}ms`);
      }
    } catch (err) {
      failCount += 1;
      outStream.write(
        JSON.stringify({
          word: w,
          ok: false,
          error: err?.message || String(err),
          generatedAt: new Date().toISOString(),
          meta: { modelPath: MODEL_PATH },
        }) + "\n"
      );
      log(`FAILED ${w}: ${err?.message || err}`);
    }
  }

  outStream.end();
  try {
    proc.kill();
  } catch {}
  const elapsed = ((Date.now() - tAll) / 1000).toFixed(1);
  log(`Done. ok=${okCount}, fail=${failCount}, elapsed=${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
