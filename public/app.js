const $ = (id) => document.getElementById(id);

const wordInput = $("wordInput");
const searchBtn = $("searchBtn");
const expandBtn = $("expandBtn");
const markBtn = $("markBtn");

const resultsEl = $("results");
const statusEl = $("status");
const demoChipsEl = $("demoChips");
const learnedChipsEl = $("learnedChips");
const llmEl = $("llm");

const apiBase = window.location.protocol === "file:" ? "http://localhost:3000" : "";
const LEARNED_KEY = "fuzzyword.learned.v1";
const demoWords = ["affect", "capital", "precede", "dessert", "illusion", "ensure"];

let lastQuery = "";
let learned = loadLearned();

function setStatus(text, kind = "info") {
  statusEl.textContent = text;
  const colors = {
    info: "var(--muted)",
    ok: "#166534",
    warn: "#92400e",
    err: "#b91c1c",
  };
  statusEl.style.color = colors[kind] || colors.info;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createChip(word, opts = {}) {
  const el = document.createElement("div");
  el.className = `chip ${opts.danger ? "chip-danger" : ""}`.trim();
  el.textContent = word;
  el.onclick = opts.onClick
    ? opts.onClick
    : () => {
        wordInput.value = word;
        doSearch();
      };
  return el;
}

function renderDemoChips() {
  demoChipsEl.innerHTML = "";
  demoWords.forEach((w) => demoChipsEl.appendChild(createChip(w)));
}

function loadLearned() {
  try {
    const raw = localStorage.getItem(LEARNED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveLearned() {
  localStorage.setItem(LEARNED_KEY, JSON.stringify(learned.slice(0, 120)));
}

function addLearned(word) {
  const w = String(word || "").trim().toLowerCase();
  if (!w) return;
  learned = learned.filter((x) => x !== w);
  learned.unshift(w);
  saveLearned();
  renderLearnedChips();
}

function removeLearned(word) {
  const w = String(word || "").trim().toLowerCase();
  learned = learned.filter((x) => x !== w);
  saveLearned();
  renderLearnedChips();
}

function renderLearnedChips() {
  learnedChipsEl.innerHTML = "";
  if (learned.length === 0) {
    const hint = document.createElement("div");
    hint.className = "status";
    hint.textContent = "暂无已学单词：搜索后点「已学 ✓」即可添加。";
    learnedChipsEl.appendChild(hint);
    return;
  }
  learned.slice(0, 30).forEach((w) => {
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.gap = "6px";
    container.style.alignItems = "center";

    const chip = createChip(w);
    const del = createChip("×", {
      danger: true,
      onClick: () => removeLearned(w),
    });
    del.title = "从已学单词中移除";
    del.style.padding = "6px 10px";

    container.appendChild(chip);
    container.appendChild(del);
    learnedChipsEl.appendChild(container);
  });
}

function renderResults(list) {
  resultsEl.innerHTML = "";
  if (!list || list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "没有找到形近词：可以换个单词试试，或扩充本地词典。";
    resultsEl.appendChild(empty);
    return;
  }

  const formatNum = (v, digits = 3) =>
    typeof v === "number" ? v.toFixed(digits) : String(v ?? "");

  list.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";

    const rules =
      item.ruleHits && item.ruleHits.length ? item.ruleHits.join(" | ") : "未命中规则";
    const steps =
      item.diffSteps && item.diffSteps.length
        ? item.diffSteps.map(escapeHtml).join("<br>")
        : "拼写相同";

    const signals = item.signals
      ? `编辑相似度 ${formatNum(item.signals.editSim)} · 词缀 ${formatNum(
          item.signals.affixSim
        )} · 键盘相邻命中 ${item.signals.keyboardHits || 0}`
      : "";

    card.innerHTML = `
      <h3>
        <button class="word-btn" data-word="${escapeHtml(item.word)}">${escapeHtml(
          item.word
        )}</button>
        <span class="pill">${escapeHtml(item.pos || "-")}</span>
      </h3>
      <div class="meaning">${escapeHtml(item.meaning || "")}</div>
    `;

    card.querySelector(".word-btn")?.addEventListener("click", (e) => {
      const w = e.currentTarget?.getAttribute("data-word") || "";
      if (!w) return;
      wordInput.value = w;
      doSearch();
    });

    resultsEl.appendChild(card);
  });
}

function renderLlmEmpty(message, kind = "info") {
  llmEl.innerHTML = "";
  const p = document.createElement("div");
  p.className = "status";
  p.textContent = message;
  p.style.marginTop = "0";
  llmEl.appendChild(p);
  setStatus(message, kind);
}

function renderLlm(payload) {
  llmEl.innerHTML = "";
  if (!payload) {
    renderLlmEmpty("暂无拓展内容。", "warn");
    return;
  }

  const { cn, synonyms, related, examples, rawText } = payload;

  const top = document.createElement("div");
  top.className = "row";
  top.innerHTML = `
    <span class="pill">Qwen</span>
    <span style="color: var(--muted); font-size: 13px;">用于生成近义词 / 用法（离线）</span>
  `;
  llmEl.appendChild(top);

  if (cn) {
    const h = document.createElement("h4");
    h.textContent = "中文释义 / 提示";
    llmEl.appendChild(h);
    const div = document.createElement("div");
    div.textContent = cn;
    llmEl.appendChild(div);
  }

  if (Array.isArray(synonyms) && synonyms.length) {
    const h = document.createElement("h4");
    h.textContent = "近义词";
    llmEl.appendChild(h);
    const ul = document.createElement("ul");
    synonyms.slice(0, 14).forEach((s) => {
      const li = document.createElement("li");
      if (typeof s === "string") li.textContent = s;
      else li.textContent = `${s.en}${s.cn ? ` · ${s.cn}` : ""}${s.note ? `（${s.note}）` : ""}`;
      ul.appendChild(li);
    });
    llmEl.appendChild(ul);
  }

  if (Array.isArray(related) && related.length) {
    const h = document.createElement("h4");
    h.textContent = "相关表达 / 搭配";
    llmEl.appendChild(h);
    const ul = document.createElement("ul");
    related.slice(0, 12).forEach((s) => {
      const li = document.createElement("li");
      if (typeof s === "string") li.textContent = s;
      else li.textContent = `${s.en}${s.cn ? ` · ${s.cn}` : ""}`;
      ul.appendChild(li);
    });
    llmEl.appendChild(ul);
  }

  if (Array.isArray(examples) && examples.length) {
    const h = document.createElement("h4");
    h.textContent = "例句";
    llmEl.appendChild(h);
    const ul = document.createElement("ul");
    examples.slice(0, 6).forEach((ex) => {
      const li = document.createElement("li");
      if (typeof ex === "string") li.textContent = ex;
      else li.textContent = `${ex.en}${ex.cn ? ` / ${ex.cn}` : ""}`;
      ul.appendChild(li);
    });
    llmEl.appendChild(ul);
  }

  if (!cn && (!synonyms || !synonyms.length) && (!related || !related.length)) {
    const h = document.createElement("h4");
    h.textContent = "模型输出（原文）";
    llmEl.appendChild(h);
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.margin = "8px 0 0 0";
    pre.textContent = rawText || "";
    llmEl.appendChild(pre);
  }
}

async function fetchJson(url) {
  const resp = await fetch(url);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    // ignore
  }
  return { resp, data };
}

async function doSearch() {
  const word = wordInput.value.trim();
  lastQuery = word;
  llmEl.innerHTML = "";
  if (!word) {
    setStatus("请输入要学习的英文单词。", "err");
    return;
  }
  setStatus("正在查询形近词…");
  resultsEl.innerHTML = "";

  try {
    const { resp, data } = await fetchJson(
      `${apiBase}/api/search?word=${encodeURIComponent(word)}&k=7`
    );
    if (!resp.ok) {
      setStatus((data && data.error) || "查询失败。", "err");
      return;
    }
    renderResults(data.results);
    setStatus(`完成：${data.query} · 形近词 ${data.results.length} 个`, "ok");
  } catch (err) {
    console.error(err);
    setStatus("网络或服务器错误：请确认已运行 node server.js 并访问 http://localhost:3000", "err");
  }
}

async function doExpand() {
  const word = wordInput.value.trim();
  lastQuery = word;
  if (!word) {
    setStatus("请输入要学习的英文单词。", "err");
    return;
  }
  setStatus("一键拓展中：形近词 + 近义词（Qwen）…");
  resultsEl.innerHTML = "";
  renderLlmEmpty("正在调用本地模型生成拓展内容…（首次加载模型可能较慢）");

  try {
    const { resp, data } = await fetchJson(
      `${apiBase}/api/expand?word=${encodeURIComponent(word)}&k=7`
    );
    if (!resp.ok) {
      setStatus((data && data.error) || "拓展失败。", "err");
      renderLlmEmpty((data && data.error) || "拓展失败。", "err");
      return;
    }
    if (data.similar && Array.isArray(data.similar.results)) {
      renderResults(data.similar.results);
    } else if (Array.isArray(data.results)) {
      renderResults(data.results);
    }

    if (data.expand && data.expand.ok) {
      renderLlm(data.expand.data);
      setStatus(`完成：${data.query} · 形近词 ${data.similar?.results?.length ?? 0} 个 + 近义词拓展`, "ok");
    } else {
      const message = data.expand?.error || "Qwen 拓展不可用：请先按 README 安装 Python 依赖并配置模型路径。";
      renderLlmEmpty(message, "warn");
      setStatus(`完成：${data.query} · 形近词 ${data.similar?.results?.length ?? 0} 个（Qwen 未启用）`, "warn");
    }
  } catch (err) {
    console.error(err);
    renderLlmEmpty("网络或服务器错误：请确认后端服务正在运行。", "err");
    setStatus("网络或服务器错误：请确认后端服务正在运行。", "err");
  }
}

searchBtn.addEventListener("click", doSearch);
expandBtn.addEventListener("click", doExpand);
markBtn.addEventListener("click", () => {
  if (!lastQuery) lastQuery = wordInput.value.trim();
  if (!lastQuery) {
    setStatus("先搜索一个单词再加入“已学”。", "warn");
    return;
  }
  addLearned(lastQuery);
  setStatus(`已加入“已学”：${lastQuery.toLowerCase()}`, "ok");
});

wordInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (e.shiftKey) doExpand();
  else doSearch();
});

renderDemoChips();
renderLearnedChips();
renderLlmEmpty("点击「一键拓展」可生成近义词/搭配/例句（需要本地 Qwen 模型环境）。");
