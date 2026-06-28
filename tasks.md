# tasks.md — `pptscript` build & progress tracker

Mirrors `PLAN.md`. Check boxes as you go. Each task has **Done-when** (acceptance)
and notes which review finding it closes (C#/H#/M#/L# from the plan review).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

---

## BUILD STATUS (2026-06-28)

**Code: complete.** All 5 files written, syntax-checked, unit test green, real
Chromium launch smoke-tested with stealth + cookie API confirmed.

| Verified mechanically (no FB account needed) | Status |
|----------------------------------------------|--------|
| pnpm setup, deps, Chromium download/launch   | ✅ done |
| `node test_parse.mjs` (name extraction)      | ✅ pass |
| `node --check` all sources                   | ✅ pass |
| stealth launch, `browser.cookies/setCookie`  | ✅ confirmed (puppeteer v25) |
| `navigator.webdriver` evasion                | ✅ false |

| Needs YOUR account to verify (can't automate) | Status |
|-----------------------------------------------|--------|
| First headful login + 2FA/checkpoint flow     | ⏳ run it: `pptscript --username x --pass y` |
| Cookie fast-path (2nd run, headless)          | ⏳ |
| Live Messenger selectors (thread scrape)      | ⏳ likely needs tuning vs real DOM |

**Run it:** `node src/cli.js --username YOU --pass 'PASS'` (first run opens a
window for 2FA). If scrape prints nothing → exit 3 → re-tune selectors in
`src/threads.js` per §6 of PLAN.md.

---

---

## Phase 0 — Setup (one-time)

- [ ] **0.1 Init project**
  - `pnpm init` · `pnpm pkg set type=module` · `pnpm pkg set bin.pptscript=./src/cli.js`
  - **Done-when:** `package.json` has `"type":"module"` and `bin.pptscript`.
- [x] **0.2 Allow Puppeteer build script** *(M1 — corrected for pnpm 11)*
  - pnpm 11 ignores `package.json` `pnpm.onlyBuiltDependencies`. Real home:
    `pnpm-workspace.yaml` → `allowBuilds: { puppeteer: true }`.
  - **Done-when:** `pnpm-workspace.yaml` has `allowBuilds.puppeteer: true`; `pnpm install` exits 0 with no ignored-build error. ✅
- [x] **0.3 Install deps**
  - `pnpm add puppeteer puppeteer-extra puppeteer-extra-plugin-stealth`
  - **Done-when:** 3 deps in `package.json`. ✅ (puppeteer ^25.2.1)
- [x] **0.4 Fetch + verify Chromium** *(pnpm gotcha — hit it, fixed it)*
  - `pnpm add` did NOT download Chromium (build script blocked). Non-interactive fix:
    `node node_modules/puppeteer/install.mjs`.
  - **Done-when:** Chrome in `~/.cache/puppeteer`; launch smoke test passes. ✅
    (chrome 150.0.7871.24 downloaded; headless launch + `browser.cookies`/`setCookie` confirmed)
- [ ] **0.5 .gitignore + dev link**
  - `printf 'node_modules\ncookies.json\n.env\n' > .gitignore` · `pnpm link --global`
  - **Done-when:** `which pptscript` resolves (after cli.js exists in 1.x).

---

## Phase 1 — CLI skeleton (`src/cli.js`)

- [ ] **1.1 Shebang + executable** *(L1)*
  - Line 1 = `#!/usr/bin/env node`; `chmod +x src/cli.js`.
  - **Done-when:** `./src/cli.js` runs directly without `node`.
- [ ] **1.2 Arg parsing with `node:util parseArgs`** *(M5)*
  - Declare `username`/`pass`/`out` as `{type:'string'}`, `headful` as `{type:'boolean'}`.
  - `out` default `./cookies.json`.
  - **Done-when:** `pptscript --username a --pass b --headful` parses; `--headful` bare flag doesn't throw.
- [ ] **1.3 Required-arg validation** *(M5)*
  - parseArgs has no "required": if no cookie cache exists AND (no `--username` OR no `--pass`) → stderr + **exit 1**.
  - **Done-when:** running with no args and no cookies exits 1 with a clear stderr message.
- [ ] **1.4 stdout/stderr discipline** *(plan §4)*
  - Thread names → **stdout** only. All logs/prompts → **stderr**.
  - **Done-when:** `pptscript ... 2>/dev/null` would show only names (verified later in Phase 5).

---

## Phase 2 — Browser launch (`src/cli.js`)

- [ ] **2.1 Stealth browser launch**
  - `puppeteer-extra` + `.use(StealthPlugin())`; `headless` = `false` if `--headful` or no cookie cache, else `true`.
  - **Done-when:** browser opens `https://www.messenger.com/` headful, no "unsupported browser" wall; screenshot saved to scratch for proof.
- [ ] **2.2 Sane navigation/timeout defaults** *(M2)*
  - `page.goto(..., {waitUntil:'domcontentloaded'})` (NOT `networkidle2` — websockets never settle). Explicit `waitForSelector` timeouts downstream.
  - **Done-when:** goto returns without hanging 30s.

---

## Phase 3 — Auth (`src/auth.js`)

- [ ] **3.1 `isLoggedIn(page)` predicate — single source of truth** *(H3)*
  - `waitForSelector('[role="grid"] [role="row"], [role="navigation"] a[href*="/t/"]', {timeout:15000}).then(()=>true).catch(()=>false)`.
  - **Never** decide login from URL.
  - **Done-when:** returns true on a logged-in inbox, false on the login page. Used in 3.3, 3.4, 4.x.
- [ ] **3.2 Cookie save/restore via BROWSER, not page** *(C1)*
  - Save: `fs.writeFileSync(out, JSON.stringify(await browser.cookies()))`.
  - Restore: `await browser.setCookie(...JSON.parse(fs.readFileSync(out)))`.
  - **Done-when:** no deprecation warning; cookies.json is valid JSON array.
- [ ] **3.3 Cookie fast-path — restore BEFORE goto** *(C2)*
  - Order: read file → `browser.setCookie(...)` → `page.goto(messenger)` → `isLoggedIn`?
  - **Done-when:** with valid cookies, headless run lands logged-in, password never used.
- [ ] **3.4 Password login (headful) + 2FA/checkpoint/trust-device** *(H2)*
  - Type creds → submit → `isLoggedIn`?
  - If 2FA/checkpoint/"Trust this device": stderr prompt "solve in window, click through Trust/Continue until chat list shows, THEN press Enter", wait on stdin, re-check `isLoggedIn`, then save cookies.
  - **Done-when:** first headful login reaches inbox, writes cookies.json AFTER chat list visible.
- [ ] **3.5 Stale-cookie fallback branch** *(H4)*
  - Fast-path `isLoggedIn` false → fall through to 3.4 password login → re-save cookies.
  - On login failure/checkpoint unsolved → **exit 2**.
  - **Done-when:** deleting/corrupting cookies.json triggers re-login (headful) instead of crashing.

---

## Phase 4 — Scrape (`src/threads.js`)

- [ ] **4.1 Pure `pickName({title, ariaLabel})` helper** *(M4)*
  - Clean `title` wins (preserves commas); aria-label `split(',')[0]` is lossy fallback only.
  - **Done-when:** exported, used by extractor.
- [ ] **4.2 Row extraction in `page.evaluate`**
  - `[role="grid"] [role="row"]` → per row prefer `span[dir="auto"]` text, fallback `a[role="link"][aria-label]`.
  - **Done-when:** returns a non-empty name array on a real inbox.
- [ ] **4.3 De-virtualize: scroll INNER container with cap** *(H5)*
  - Find scrollable ancestor (`scrollHeight > clientHeight`), `el.scrollTop = el.scrollHeight`, settle delay, collect into `Set`. Stop on (stable N rounds) AND (absolute ceiling ~50).
  - `window.scrollTo` does nothing — must be the inner element.
  - **Done-when:** scraped count ≈ visible conversation count; loop always terminates.
- [ ] **4.4 Zero-rows handling** *(M3)*
  - `names.length === 0` → **exit 3** + stderr "no rows — run --headful, re-tune selectors in threads.js". Never silent-empty stdout.
  - **Done-when:** forcing a bad selector exits 3 with the hint, not exit 0.
- [ ] **4.5 messenger.com ONLY** *(C3/X1)*
  - No facebook.com/messages fallback (different cookie domain + second selector set).
  - **Done-when:** no facebook.com navigation anywhere in code.

---

## Phase 5 — Wire-up & polish

- [ ] **5.1 Orchestrate in cli.js**
  - launch → `ensureLoggedIn(browser,page,opts)` → `collectThreadNames(page)` → print names to stdout → close browser.
  - **Done-when:** `pptscript --username x --pass y` end-to-end prints thread names.
- [ ] **5.2 Exit codes** *(plan §4)*
  - `0` ok · `1` bad args · `2` login/checkpoint fail · `3` scrape empty.
  - **Done-when:** each path returns the right `$?`.
- [ ] **5.3 Pipe-clean output**
  - **Done-when:** `pptscript --username x --pass y 2>/dev/null | head` shows only names; `| grep Mom` works.
- [ ] **5.4 README**
  - Usage, first-run-headful note, cookie cache, `$FB_PASS` env alternative to flag *(security)*, selector-rot recovery steps.
  - **Done-when:** README covers setup + the 2FA-first-run flow.

---

## Phase 6 — Test & verify

- [ ] **6.1 `test_parse.mjs`** *(M4 / one runnable check)*
  - Asserts `pickName` incl. comma-in-name case (`'Smith, Jane'` preserved).
  - **Done-when:** `node test_parse.mjs` prints `ok`.
- [ ] **6.2 Manual e2e on real account**
  - First run headful (solve 2FA) → cookies saved → second run headless prints names.
  - **Done-when:** two consecutive runs succeed, second without password.

---

## Deferred (YAGNI — do NOT build unless asked)
- `--json` structured output · `--limit` cap · message *contents* · multi-account
- proxy rotation / headless-server deploy / scheduling · DB output
- Marketplace/Requests sub-folders

---

## Review findings → task map (traceability)
| Finding | Severity | Closed by |
|---------|----------|-----------|
| C1 deprecated `page.cookies` | CRITICAL | 3.2 |
| C2 restore-before-goto | CRITICAL | 3.3 |
| C3 cross-domain cookies | CRITICAL | 4.5 |
| H1 stealth over-reliance | HIGH | plan §0/§1 reworded (no code task) |
| H2 trust-device screen | HIGH | 3.4 |
| H3 login = chat-list, not URL | HIGH | 3.1 |
| H4 logged-out detection/fallback | HIGH | 3.5 |
| H5 inner-scroll + cap | HIGH | 4.3 |
| M1 pnpm build-script order | MED | 0.2 |
| M2 timeouts/waitUntil | MED | 2.2 |
| M3 zero-rows → exit 3 | MED | 4.4 |
| M4 comma-in-name bug | MED | 4.1, 6.1 |
| M5 parseArgs typing/required | MED | 1.2, 1.3 |
| L1 shebang + chmod | LOW | 1.1 |
| L3 --out CWD-relative | LOW | 1.2 (default `./cookies.json` + doc) |
| X1 drop fb.com fallback | cut | 4.5 |
