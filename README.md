# CodeSense — AI code explainer & mentor

Paste any code, pick a mentor mode, and get an AI explanation instantly.
No signup, no API key, no build step — a single static page that runs from
GitHub Pages.

![modes](https://img.shields.io/badge/modes-4-brightgreen)
![stack](https://img.shields.io/badge/stack-HTML%2FCSS%2FJS-blue)

## What it does

CodeSense is the tool for the "what does this function even do" moment:
paste code (Python, C, C++, Java, JavaScript), choose one of four mentor
modes — **Explain like I'm 5**, **Walk me through it** (line-by-line),
**Find bugs**, or **Make it better** — and get a plain-language answer from
an AI mentor in seconds.

## Features

- **Code input** with a live character counter (capped at 6000 chars to be
  kind to the free API tier) and a language picker (Python / C / C++ /
  Java / JavaScript / Auto-detect with live heuristic guessing while you type)
- **4 mentor modes** with pre-baked prompt templates (hidden from the UI):
  ELI5 analogies, line-by-line walkthrough, bug-hunting code review with
  severity + fix suggestions, and an improvement pass that returns a cleaner
  rewritten version
- **Rendered markdown answers** — headings, lists, bold/italic, inline code,
  blockquotes, and fenced code blocks render natively (no library)
- **Syntax-highlighted preview** of your submitted code (keywords, strings,
  numbers, comments, function calls; comment style adapts to the language)
- **Loading / error / retry states** — friendly messages on rate limits
  (429), timeouts (60 s cap), and empty responses
- **Copy button** for the full answer
- **History** — your last 10 asks saved in `localStorage` (code snippet,
  mode, language, timestamp); one-click clear
- Fully responsive; works offline for everything except the AI call itself

## How to run

It's a static site — no build step:

```bash
# Option 1: open index.html directly in a browser
# Option 2: serve locally (needed for the clipboard API on some browsers)
python3 -m http.server 8000
# then visit http://localhost:8000
```

Or deploy free on **GitHub Pages**: repo → Settings → Pages → Deploy from
branch → `main` → `/ (root)`.

## How the AI integration works (and API keys)

There is no API key and no signup. The app POSTs to the free, keyless
Pollinations OpenAI-compatible endpoint:

```
POST https://text.pollinations.ai/openai/v1/chat/completions
{
  "model": "openai",
  "private": true,
  "messages": [{ "role": "user", "content": "<hidden prompt template> + ```lang\n<code>\n```" }]
}
```

- Each mode has a **pre-baked system-style template** (in `PROMPTS` in
  `app.js`) that frames the model's role (teacher, mentor, reviewer, senior
  engineer) and the exact output shape. Your code is sent as a **fenced
  code block**, so the model treats it as data rather than instructions.
- `private: true` asks the endpoint not to log the prompt publicly.
- Client-side guardrails: 6000-char input cap, request debounce (button
  disabled while a request is in flight), 60 s timeout via
  `AbortController`, and distinct error states for 429 rate limits vs
  network/timeout failures — with a retry button.
- ⚠️ Don't paste secrets, credentials, or private company code: the code
  you submit is sent to a third-party AI API (the UI warns about this).

## Project structure

```
index.html   — page structure: input card, mode picker, output card, history
styles.css   — full theme, responsive layout, syntax-token colors
app.js       — language detection, highlighter, markdown renderer,
               API call, history (localStorage), UI wiring
```

## Interview notes

**What the project is:** CodeSense is a client-side AI code-explainer web
app. You paste code, pick one of four mentor modes (ELI5, line-by-line
walkthrough, bug finder, improvement pass), and it calls a free keyless LLM
API with a hidden pre-baked prompt template, then renders the markdown
answer with a custom renderer.

**Key technical decisions (and why):**

1. **Keyless Pollinations API instead of OpenAI with a key** — the goal was
   "paste and it just works", with zero signup friction for a student
   audience and free GitHub Pages hosting. The trade-off is an anonymous
   tier that rate-limits: I mitigated it with a 6000-char cap, request
   debounce, a 60 s timeout, and explicit 429 handling rather than a
   generic "something went wrong".
2. **Hidden per-mode prompt templates instead of letting the user write
   prompts** — each mode needs a very specific output shape (e.g. severity
   labels in bug mode, a rewritten code block in improve mode). Baking the
   templates in keeps the UX to one click, and sending the code as a fenced
   block keeps it as data, reducing prompt-injection weirdness.
3. **Custom line-based markdown renderer instead of a library (marked.js
   etc.)** — the AI's output uses a small, predictable subset (headings,
   lists, bold/italic, inline + fenced code). A ~60-line renderer avoids a
   dependency entirely and keeps the page offline-capable. It extracts
   fenced blocks *before* parsing so code inside them is never mangled, and
   everything is HTML-escaped first, so a model response can never inject
   scripts.
4. **Regex syntax highlighter for the submitted-code preview** — deliberately
   lightweight (a high-schooler reading the source can follow it) rather
   than pulling in Prism/highlight.js. Comment patterns adapt to the
   language (`#` vs `//`/`/* */`).
5. **History in localStorage, not a backend** — there's no server at all;
   the last 10 asks persist on the user's machine. Simple, private, free.

**Trade-offs / limitations:**

- The anonymous API tier can 429 or time out under load — there's no API
  key fallback, so heavy users will hit this.
- Language auto-detect is a heuristic scorer, not a real parser; it can
  mislabel short or mixed snippets (the manual dropdown overrides it).
- The markdown renderer handles the common subset only; exotic markdown
  (tables, nested lists) degrades to plain paragraphs.
- Explanations are only as good as the free model behind the endpoint;
  there's no caching, so repeated identical asks cost repeated requests.
- No streaming — the answer appears all at once after the full response
  arrives (a streaming UI would need SSE handling on the fetch).

**How I'd extend it:**

- Streaming responses with a typewriter effect via SSE for a snappier feel.
- A diff view for "Make it better" mode showing old vs improved code
  side-by-side.
- "Explain this error" mode: paste a traceback + the code and get the fix.
- Optional BYOK (bring-your-own-key) field for OpenAI/Anthropic so power
  users skip the free-tier limits, stored in localStorage.
- Export answer as a Markdown file download.
