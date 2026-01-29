const $ = (id) => document.getElementById(id);

const wordInput = $("wordInput");
const queryBtn = $("queryBtn");
const statusEl = $("status");
const llmEl = $("llm");
const cacheBadge = $("cacheBadge");

const apiBase = window.location.protocol === "file:" ? "http://localhost:3000" : "";

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

function renderEmpty(message) {
  llmEl.innerHTML = "";
  const p = document.createElement("div");
  p.className = "status";
  p.style.marginTop = "0";
  p.textContent = message;
  llmEl.appendChild(p);
}

function render(payload) {
  llmEl.innerHTML = "";
  if (!payload) {
    renderEmpty("没有内容。");
    return;
  }

  const { cn, synonyms, related, examples, rawText } = payload;

  const top = document.createElement("div");
  top.className = "row";
  top.innerHTML = `
    <span class="pill">Qwen</span>
    <span style="color: var(--muted); font-size: 13px;">来自离线缓存</span>
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

async function refreshCacheStatus() {
  try {
    const { resp, data } = await fetchJson(`${apiBase}/api/cache/status`);
    if (!resp.ok || !data?.ok) throw new Error("bad response");
    cacheBadge.textContent = `缓存 ${data.size} 条 · ${data.exists ? "已存在" : "未生成"} · live=${data.liveEnabled ? "开" : "关"}`;
  } catch {
    cacheBadge.textContent = "缓存状态不可用";
  }
}

async function query() {
  const word = wordInput.value.trim();
  if (!word) {
    setStatus("请输入单词。", "err");
    renderEmpty("暂无内容。");
    return;
  }
  setStatus("查询中…", "info");
  renderEmpty("读取缓存中…");
  try {
    const { resp, data } = await fetchJson(
      `${apiBase}/api/llm?word=${encodeURIComponent(word)}`
    );
    if (!resp.ok) {
      setStatus(data?.error || "未找到缓存。", "warn");
      renderEmpty(data?.error || "未找到缓存。");
      return;
    }
    setStatus(`已加载：${data.query}`, "ok");
    render(data.data);
  } catch (e) {
    console.error(e);
    setStatus("网络或服务器错误：请确认已运行 node server.js 并访问 http://localhost:3000", "err");
    renderEmpty("请求失败。");
  }
}

queryBtn.addEventListener("click", query);
wordInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  query();
});

refreshCacheStatus();
renderEmpty("输入单词后查询离线拓展。");

