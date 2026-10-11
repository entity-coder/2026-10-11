/* ============================================================
 * CodeSense — AI code explainer & mentor (app.js)
 * Plain JS, no dependencies, no build step.
 *
 * Flow: paste code -> pick a mentor mode -> POST the code +
 * a pre-baked hidden prompt to the keyless Pollinations
 * OpenAI-compatible endpoint -> render the answer as markdown.
 * ============================================================ */

"use strict";

// ---------- config ----------
const API_URL = "https://text.pollinations.ai/openai/v1/chat/completions";
const API_MODEL = "openai";               // keyless, no signup (same as Briefly, 2026-10-08)
const MAX_CHARS = 6000;                   // client-side cap: protects the anonymous tier
const HISTORY_LIMIT = 10;
const HISTORY_KEY = "codesense-history-v1";
const REQUEST_TIMEOUT_MS = 60000;

// ---------- pre-baked prompt templates (one per mode; hidden from the UI) ----------
// The user's code is sent as a fenced block after the template so the model
// treats it as data, never as instructions.
const PROMPTS = {
  eli5: {
    label: "Explain like I'm 5",
    template:
      "You are a friendly teacher. Explain the following code as if the reader " +
      "is five years old: use one simple real-life analogy, no jargon, and " +
      "finish with one short sentence saying what the code actually does. " +
      "Use markdown formatting (headings, bold, bullets). Keep it under 250 words.\n\n" +
      "Code:\n",
  },
  walkthrough: {
    label: "Walk me through it",
    template:
      "You are a patient programming mentor. Walk through the following code " +
      "step by step: for each important line or block, say what it does and " +
      "why it matters. Start with a one-line summary, then a markdown list " +
      "ordered by execution. Keep each step to one or two sentences.\n\n" +
      "Code:\n",
  },
  bugs: {
    label: "Find bugs",
    template:
      "You are a meticulous code reviewer. Review the following code for bugs, " +
      "edge cases, and common pitfalls. List each issue as a markdown bullet " +
      "with: severity (high/medium/low), where it is, why it is a problem, and " +
      "a one-line fix. If the code looks clean, say so and give 2-3 defensive " +
      "suggestions. Be honest — do not invent problems that are not there.\n\n" +
      "Code:\n",
  },
  improve: {
    label: "Make it better",
    template:
      "You are a senior engineer. Suggest how to improve the following code: " +
      "cleaner structure, better performance, readability. Give 2-4 concrete " +
      "suggestions with short reasons, then show ONE improved version of the " +
      "code in a fenced code block. Use markdown formatting. Keep the improved " +
      "version close to the original style so a student can follow it.\n\n" +
      "Code:\n",
  },
};

// ---------- syntax-highlight keyword tables (for the code preview only) ----------
const KEYWORDS = {
  python: ["def", "class", "return", "import", "from", "as", "if", "elif", "else",
    "for", "while", "in", "not", "and", "or", "is", "None", "True", "False",
    "try", "except", "finally", "with", "lambda", "pass", "raise", "yield", "print"],
  c: ["int", "char", "float", "double", "void", "return", "if", "else", "for",
    "while", "do", "switch", "case", "break", "continue", "struct", "typedef",
    "sizeof", "const", "static", "#include", "#define"],
  cpp: ["int", "char", "float", "double", "void", "return", "if", "else", "for",
    "while", "do", "switch", "case", "break", "continue", "struct", "class",
    "public", "private", "namespace", "using", "new", "delete", "const",
    "static", "template", "#include", "std"],
  java: ["public", "private", "protected", "class", "static", "void", "int",
    "long", "double", "float", "boolean", "char", "return", "if", "else",
    "for", "while", "do", "switch", "case", "break", "continue", "new",
    "this", "extends", "implements", "import", "package", "null", "true", "false"],
  javascript: ["function", "return", "const", "let", "var", "if", "else", "for",
    "while", "do", "switch", "case", "break", "continue", "new", "this",
    "typeof", "null", "undefined", "true", "false", "class", "extends",
    "import", "export", "from", "async", "await", "try", "catch", "throw"],
};

// ---------- DOM ----------
const codeInput = document.getElementById("code-input");
const charCount = document.getElementById("char-count");
const languageSelect = document.getElementById("language");
const detectedLang = document.getElementById("detected-lang");
const modeButtons = document.querySelectorAll(".mode-btn");
const explainBtn = document.getElementById("explain-btn");
const outputCard = document.getElementById("output-card");
const outputTitle = document.getElementById("output-title");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const errorMsg = document.getElementById("error-msg");
const retryBtn = document.getElementById("retry-btn");
const answerEl = document.getElementById("answer");
const copyBtn = document.getElementById("copy-btn");
const codeDisplay = document.getElementById("code-display");
const historyCard = document.getElementById("history-card");
const historyList = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");

let currentMode = "eli5";
let lastRequest = null;   // { code, lang, mode } — kept for retry
let lastAnswerText = "";  // raw markdown, used by the copy button

// ============================================================
// 1. Language detection (cheap heuristics — good enough for a hint)
// ============================================================
function detectLanguage(code) {
  const scores = { python: 0, c: 0, cpp: 0, java: 0, javascript: 0 };
  const has = (re) => (code.match(re) || []).length;

  scores.python += 3 * has(/^\s*(def |class |import |from \w+ import )/gm);
  scores.python += 2 * has(/:\s*(#.*)?$/gm) && has(/\bprint\(/) ? 2 : 0;

  scores.java += 4 * has(/\bpublic\s+(class|static)\b/);
  scores.java += 2 * has(/System\.out/);

  scores.cpp += 3 * has(/#include\s*</);
  scores.cpp += 3 * has(/\b(std::|cout|cin)\b/);

  scores.c += 2 * has(/#include\s*"/) + 2 * has(/\bprintf?\(/);
  scores.c += 2 * has(/\bint\s+main\s*\(/);

  scores.javascript += 3 * has(/\b(console\.log|function\s+\w+\s*\(|=>)\b/);
  scores.javascript += 2 * has(/^\s*(const|let)\s+\w+/gm);

  let best = "python";
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return bestScore > 0 ? best : "python"; // fallback guess
}

function getLanguage() {
  const chosen = languageSelect.value;
  if (chosen !== "auto") {
    detectedLang.hidden = true;
    return chosen;
  }
  const guess = detectLanguage(codeInput.value);
  detectedLang.textContent = "looks like " + guess;
  detectedLang.hidden = false;
  return guess;
}

// ============================================================
// 2. Tiny syntax highlighter (runs on the *submitted* code preview)
// ============================================================
function highlightCode(code, lang) {
  const keywords = KEYWORDS[lang] || [];
  const kwPattern = keywords.length ? "\\b(" + keywords.join("|") + ")\\b" : "(?!)";
  // Python uses # comments; the C family uses // and /* */.
  const commentPattern = lang === "python" ? "#[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const pattern = new RegExp(
    "(" + commentPattern + ")" +                    // 1: comment
    "|(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')" + // 2: string
    "|\\b(\\d+(?:\\.\\d+)?)\\b" +                    // 3: number
    "|" + kwPattern +                               // 4: keyword
    "|\\b([A-Za-z_]\\w*)(?=\\s*\\()",                // 5: function call
    "g"
  );
  return escapeHtml(code).replace(pattern,
    (m, com, str, num, kw, fn) => {
      if (com) return '<span class="tok-com">' + com + "</span>";
      if (str) return '<span class="tok-str">' + str + "</span>";
      if (num) return '<span class="tok-num">' + num + "</span>";
      if (kw)  return '<span class="tok-kw">' + kw + "</span>";
      if (fn)  return '<span class="tok-fn">' + fn + "</span>";
      return m;
    }
  );
}

// ============================================================
// 3. Markdown-ish renderer for the AI answer
//    (line-based; handles fenced code blocks, headings, lists,
//     blockquotes, bold/italic/inline code)
// ============================================================
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(s) {
  // inline code first (protect it from bold/italic parsing)
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s;
}

function renderMarkdown(md) {
  // 1. Pull fenced code blocks out so nothing inside them gets parsed.
  const blocks = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push({ lang, code });
    return "\u0000BLOCK" + (blocks.length - 1) + "\u0000";
  });

  const lines = escapeHtml(text).split("\n");
  let html = "";
  let listOpen = null; // "ul" | "ol"

  const closeList = () => {
    if (listOpen) { html += "</" + listOpen + ">"; listOpen = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // fenced-block placeholder -> re-insert as <pre><code>
    const blockMatch = trimmed.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (blockMatch) {
      closeList();
      const b = blocks[Number(blockMatch[1])];
      html += "<pre><code>" + escapeHtml(b.code.replace(/\n$/, "")) + "</code></pre>";
      continue;
    }
    if (trimmed === "") { closeList(); continue; }

    let m;
    if ((m = trimmed.match(/^(#{1,6})\s+(.*)/))) {
      closeList();
      const level = m[1].length;
      html += "<h" + level + ">" + renderInline(m[2]) + "</h" + level + ">";
    } else if ((m = trimmed.match(/^>\s?(.*)/))) {
      closeList();
      html += "<blockquote>" + renderInline(m[1]) + "</blockquote>";
    } else if ((m = trimmed.match(/^([-*])\s+(.*)/))) {
      if (listOpen !== "ul") { closeList(); html += "<ul>"; listOpen = "ul"; }
      html += "<li>" + renderInline(m[2]) + "</li>";
    } else if ((m = trimmed.match(/^\d+[.)]\s+(.*)/))) {
      if (listOpen !== "ol") { closeList(); html += "<ol>"; listOpen = "ol"; }
      html += "<li>" + renderInline(m[1]) + "</li>";
    } else {
      closeList();
      html += "<p>" + renderInline(trimmed) + "</p>";
    }
  }
  closeList();
  return html;
}

// ============================================================
// 4. API call
// ============================================================
async function explainCode(code, lang, mode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: API_MODEL,
        private: true, // don't let the free endpoint log the prompt publicly
        messages: [{
          role: "user",
          content: PROMPTS[mode].template + "```" + lang + "\n" + code + "\n```",
        }],
      }),
    });

    if (response.status === 429) {
      throw new Error("The free AI service is rate-limited right now. Wait a minute, then try again.");
    }
    if (!response.ok) {
      throw new Error("The AI service returned an error (" + response.status + "). Try again in a bit.");
    }

    const data = await response.json();
    const text = data && data.choices && data.choices[0] &&
                 data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("The AI service returned an empty answer. Try again.");
    return text.trim();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("The request timed out after 60 seconds. The service may be busy — try again.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// 5. UI wiring
// ============================================================
function updateCharCount() {
  const n = codeInput.value.length;
  charCount.textContent = n + " / " + MAX_CHARS;
  charCount.classList.toggle("over", n > MAX_CHARS);
  explainBtn.disabled = n === 0 || n > MAX_CHARS || codeInput.disabled;
}

codeInput.addEventListener("input", () => {
  updateCharCount();
  // re-run auto-detect live while typing
  if (languageSelect.value === "auto" && codeInput.value.trim()) getLanguage();
});

languageSelect.addEventListener("change", () => {
  if (languageSelect.value !== "auto") detectedLang.hidden = true;
  else if (codeInput.value.trim()) getLanguage();
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    modeButtons.forEach((b) => {
      b.classList.remove("selected");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("selected");
    btn.setAttribute("aria-checked", "true");
    currentMode = btn.dataset.mode;
  });
});

function showLoading() {
  outputCard.hidden = false;
  loadingEl.hidden = false;
  errorEl.hidden = true;
  answerEl.hidden = true;
  explainBtn.disabled = true;
  outputCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showError(msg) {
  loadingEl.hidden = true;
  errorEl.hidden = false;
  answerEl.hidden = true;
  errorMsg.textContent = msg;
  explainBtn.disabled = false;
  updateCharCount();
}

function showAnswer(markdown, code, lang, mode) {
  loadingEl.hidden = true;
  errorEl.hidden = true;
  lastAnswerText = markdown;
  answerEl.innerHTML = renderMarkdown(markdown);
  answerEl.hidden = false;
  outputTitle.textContent = PROMPTS[mode].label;
  codeDisplay.innerHTML = highlightCode(code, lang);
  explainBtn.disabled = false;
  updateCharCount();
}

async function runExplain() {
  const code = codeInput.value.trim();
  if (!code) return;
  if (code.length > MAX_CHARS) {
    showError("That code is over the " + MAX_CHARS + "-character cap. Trim it and try again.");
    return;
  }
  const lang = getLanguage();
  const mode = currentMode;
  lastRequest = { code, lang, mode };

  showLoading();
  try {
    const markdown = await explainCode(code, lang, mode);
    showAnswer(markdown, code, lang, mode);
    saveToHistory({ code, lang, mode, answer: markdown, ts: Date.now() });
  } catch (err) {
    showError(err.message || "Something went wrong. Try again.");
  }
}

explainBtn.addEventListener("click", runExplain);
retryBtn.addEventListener("click", runExplain);

// Enter-explain shortcut is intentionally NOT added: code contains newlines.

// ============================================================
// 6. Copy button
// ============================================================
copyBtn.addEventListener("click", async () => {
  if (!lastAnswerText) return;
  try {
    await navigator.clipboard.writeText(lastAnswerText);
    copyBtn.textContent = "✅ Copied!";
  } catch {
    // clipboard API needs HTTPS/localhost — fall back to a select-all trick
    const ta = document.createElement("textarea");
    ta.value = lastAnswerText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    copyBtn.textContent = "✅ Copied!";
  }
  setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 2000);
});

// ============================================================
// 7. History (localStorage, last N asks)
// ============================================================
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveToHistory(entry) {
  const hist = loadHistory();
  hist.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, HISTORY_LIMIT)));
  renderHistory();
}

function renderHistory() {
  const hist = loadHistory();
  historyCard.hidden = hist.length === 0;
  historyList.innerHTML = "";
  hist.forEach((h) => {
    const li = document.createElement("li");
    const date = new Date(h.ts).toLocaleString();
    const firstLine = (h.answer || "").split("\n").find((l) => l.trim()) || "";
    li.innerHTML =
      '<div class="hist-meta"><span>' + escapeHtml(PROMPTS[h.mode] ? PROMPTS[h.mode].label : h.mode) +
      " · " + escapeHtml(h.lang) + '</span><span>' + escapeHtml(date) + "</span></div>" +
      "<pre>" + escapeHtml(h.code.slice(0, 140)) + (h.code.length > 140 ? "…" : "") + "</pre>";
    li.title = firstLine.slice(0, 200);
    historyList.appendChild(li);
  });
}

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// ---------- init ----------
renderHistory();
updateCharCount();
