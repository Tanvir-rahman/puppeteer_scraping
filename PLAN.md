# Plan: `pptscript` — Facebook Messenger thread-name scraper

CLI that logs into Facebook with Puppeteer, opens Messenger, and prints every
conversation (thread) name to the terminal.

```bash
pptscript --username x --pass y
# →  prints thread names, one per line, to stdout
```

---

## 0. Scope & reality check (read first)

**This automates *your own* Facebook account.** That is the only supported use.
Facebook's ToS discourages automation and it actively fights bots, so this is
inherently fragile. Three hard truths to design around:

1. **Bot detection** — vanilla Puppeteer trips fingerprint checks. → add the
   **stealth plugin** as *cheap insurance*, but don't lean on it: it's largely
   unmaintained and FB's detection is behavioral/account-level, not just
   fingerprint. The real defense is **reusing a cookie session** instead of
   re-logging in every run.
2. **2FA / login checkpoints** — Facebook will often throw a 2FA code, a
   "this wasn't me" checkpoint, or a CAPTCHA on a fresh automated login. These
   **cannot be fully automated** and shouldn't be (defeating them is exactly
   what the ToS forbids). → **solve it once, by hand, in a visible browser,
   then persist the session cookies** so later runs skip login entirely.
3. **Obfuscated DOM** — Messenger's class names are randomized garbage and
   change often. → select by stable-ish `role`/`aria-label` attributes, and
   accept that selectors are the part most likely to need re-tuning.

The lazy, robust design that falls out of this: **log in headful the first
time, cache cookies, run headless after.** Password flag still exists for the
first login, but cookies do the heavy lifting.

---

## 1. Stack

| Concern        | Choice                                    | Why |
|----------------|-------------------------------------------|-----|
| Runtime        | Node v24 (already installed)              | `node -v` → v24.12.0 |
| Pkg manager    | `pnpm` v11 (already installed)            | `pnpm -v` → 11.9.0 |
| Browser auto   | `puppeteer`                               | bundles a known-good Chromium |
| Anti-detection | `puppeteer-extra` + `puppeteer-extra-plugin-stealth` | hides headless/automation fingerprints |
| CLI args       | built-in `node:util` `parseArgs`          | no dependency — Node 18+ ships it |
| Cookie store   | one JSON file on disk                     | no dependency — `fs` + `browser.cookies()` (v23+ API, not `page.cookies`) |

> **pnpm gotcha (verified during build):** pnpm v10+ blocks dependency build
> scripts by default. Puppeteer downloads Chromium via a **postinstall script** →
> pnpm **skips it**, so Chromium never lands and `launch()` throws *"Could not
> find Chrome"*. In **pnpm 11** the allow-list lives in **`pnpm-workspace.yaml`**
> (`allowBuilds: { puppeteer: true }`) — the old `package.json` `pnpm.onlyBuiltDependencies`
> field is **ignored** (pnpm warns). Reliable non-interactive fetch:
> `node node_modules/puppeteer/install.mjs`. See §3. This is the one place pnpm
> differs materially from npm here.

Three runtime deps total. No arg-parsing lib, no config framework. `parseArgs`
covers `--username`/`--pass`/`--headful`/`--out`.

---

## 2. Project layout

```
puppeteer_scraping/
├── PLAN.md            ← this file
├── package.json       ← "bin": { "pptscript": "./src/cli.js" }, type: module
├── src/
│   ├── cli.js         ← arg parsing + orchestration + stdout
│   ├── auth.js        ← login + cookie load/save
│   └── threads.js     ← navigate Messenger + scrape thread names
├── .gitignore         ← node_modules, cookies.json, .env
└── cookies.json       ← gitignored session cache (created at runtime)
```

Four small files. `auth` and `threads` split so the fragile selector logic
(`threads.js`) is isolated from the fragile login logic (`auth.js`) — when one
breaks you edit one file.

---

## 3. Setup commands (run once)

```bash
cd /Users/pathaoltd/personal/puppeteer_scraping
pnpm init
pnpm pkg set type=module
pnpm pkg set bin.pptscript=./src/cli.js

pnpm add puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
# pnpm v10+ blocks build scripts, so Chromium does NOT download on the line above.
# pnpm 11 reads the allow-list from pnpm-workspace.yaml (the package.json "pnpm"
# field is IGNORED — it'll warn if you put it there):
printf 'allowBuilds:\n  puppeteer: true\n' > pnpm-workspace.yaml
# Now fetch Chromium. `pnpm approve-builds` is interactive (needs a TTY); the
# reliable non-interactive way is Puppeteer's own installer:
node node_modules/puppeteer/install.mjs

pnpm link --global    # makes `pptscript` runnable globally (dev convenience)
printf 'node_modules\ncookies.json\n.env\n' > .gitignore
```

`pnpm add puppeteer` triggers a matched-Chromium download (~150 MB) — one-time,
**only if the build script is approved** (the `onlyBuiltDependencies` line above).
Verify it actually landed: `node -e "import('puppeteer').then(p=>console.log(p.default.executablePath()))"`
should print a path to a real file.

---

## 4. CLI contract

```
pptscript --username <user> --pass <pass> [--headful] [--out cookies.json]

--username   FB email / phone / username      (required for first login)
--pass       FB password                       (required for first login)
--headful    show the browser window           (use for first login / 2FA)
--out        cookie cache path (default ./cookies.json, CWD-relative —
             run from the same dir each time, or pass an absolute path)
```

> **parseArgs setup:** declare each — `username`/`pass`/`out` as `{type:'string'}`,
> `headful` as `{type:'boolean'}` (bare flag throws otherwise). parseArgs has no
> "required" — validate yourself: missing creds **and** no cookie cache → exit 1.
> `src/cli.js` line 1 must be `#!/usr/bin/env node` and the file `chmod +x`, or the
> linked `pptscript` bin won't run.

- If a valid cookie cache exists → `--username`/`--pass` are ignored, run headless.
- Exit codes: `0` ok · `1` bad args · `2` login failed / checkpoint hit · `3` scrape found nothing.
- **stdout = thread names only** (one per line) so it pipes cleanly:
  `pptscript --username x --pass y | grep Mom`. All logs/prompts go to **stderr**.

> ⚠️ Password on the command line is visible in shell history and `ps`.
> **Implemented:** creds fall back to `$FB_USER` / `$FB_PASS` env vars when the
> flags are omitted (flags win if both given). Prefer the env path.

---

## 5. Execution flow

```
cli.js
 ├─ parseArgs()                         → {username, pass, headful, out}
 ├─ launch stealth browser              → headful if --headful or no cookies
 ├─ auth.js: ensureLoggedIn(browser, page, opts)
 │    ├─ cookies.json exists?
 │    │      → browser.setCookie(...cookies)   ← BEFORE any goto (C2)
 │    │      → page.goto(messenger)
 │    │      → isLoggedIn(page)?  (chat-list present, NOT url — see below)
 │    │           ├─ yes → done (fast path, no password used)
 │    │           └─ no  → cookies stale → fall through to password login
 │    └─ password login (requires --headful):
 │           → type username+pass, submit
 │           → isLoggedIn(page)?  → save cookies, done
 │           └─ 2FA / checkpoint / "Trust this device" screen?
 │                  → stderr: "solve in the window, click through
 │                    'Trust'/'Continue' until the chat list shows,
 │                    THEN press Enter here"
 │                  → wait on stdin → re-check isLoggedIn → save cookies
 ├─ threads.js: collectThreadNames(page)
 │    ├─ goto https://www.messenger.com/
 │    ├─ wait for chat list role="grid" / role="navigation"
 │    ├─ scroll the list to lazy-load more rows (loop until count stable)
 │    └─ extract name from each row (see §6)
 └─ print names to stdout, close browser
```

**`isLoggedIn(page)` — one predicate, three uses** (post-login, cookie fast-path,
pre-scrape). True iff the chat-list shows within timeout — **never** infer from URL
(FB bounces through `/login`, `/checkpoint/`, `/two_step_verification/`):

```js
const isLoggedIn = (page) =>
  page.waitForSelector('[role="grid"] [role="row"], [role="navigation"] a[href*="/t/"]',
    { timeout: 15000 }).then(() => true).catch(() => false);
```

**Cookies use the BROWSER, not the page** (Puppeteer v23+ deprecated `page.cookies`):

```js
// save (after confirmed login):
fs.writeFileSync(out, JSON.stringify(await browser.cookies()));
// restore — MUST run before the first page.goto, else always logged out (C2):
await browser.setCookie(...JSON.parse(fs.readFileSync(out)));
```

---

## 6. The scrape (most fragile part)

Messenger renders the conversation list as a virtualized list. Two jobs:

**a) Force everything to load.** The list virtualizes — only visible rows are in
the DOM. Scroll the **inner scrollable element** (the overflow container, found
by walking up from a `[role=row]` to the nearest ancestor where
`scrollHeight > clientHeight` — it's a plain `div`, NOT the grid) — `window.scrollTo`
does **nothing** here. Loop: `el.scrollTop = el.scrollHeight` → short settle delay →
collect names into a `Set` → repeat. Terminate on BOTH "count stable for N rounds"
**AND** an absolute iteration ceiling, so a 0-row selector or never-settling list
can't spin forever. Document the ceiling.

> **Gotcha (hit during build):** on a fresh device Messenger shows an E2EE
> *"restore your chats"* modal whose dimming overlay **swallows mouse-wheel /
> pointer events** — so `page.mouse.wheel` scrolls nothing and you're stuck at
> the first ~19 rows. **Use JS `el.scrollTop`, not the mouse wheel** — it works
> underneath the overlay, so the modal needs no dismissing. Verified: 19 → 224 names.

**b) Extract the name per row.** Best-effort selector chain, in priority order
(verify live in DevTools, they drift):

```js
// inside page.evaluate()
const rows = document.querySelectorAll('[role="grid"] [role="row"]');
const names = [];
for (const row of rows) {
  // 1) PREFER the clean title span — holds ONLY the name. Group names
  //    legitimately contain commas, so NEVER split aria-label when avoidable.
  const titleSpan = row.querySelector('span[dir="auto"]');
  // 2) last resort: aria-label, text before first comma (lossy — fallback only)
  const link = row.querySelector('a[role="link"][aria-label]');
  const name = (titleSpan?.textContent?.trim())
            || (link?.getAttribute('aria-label')?.split(',')[0].trim())
            || '';
  if (name) names.push(name);
}
// caller: names.length === 0  → exit 3 + stderr
//   "no rows — run --headful and re-tune selectors in threads.js"
```

> **Selectors WILL break eventually.** That's structural to scraping FB, not a
> bug in the plan. Recovery procedure: run `--headful`, open DevTools, inspect a
> conversation row, update the two selectors in `threads.js`. This is why
> `threads.js` is its own file.

**Stick to `messenger.com` end-to-end.** Don't mix in `facebook.com/messages` —
it's a different cookie domain (re-triggers login) and a second selector set to
maintain. One domain, one selector set.

---

## 7. Build order (TDD-ish, smallest steps)

1. **`cli.js` arg parsing** — print parsed args, exit. Verify
   `pptscript --username a --pass b` round-trips. (unit-testable, pure)
2. **Launch + stealth** — open `messenger.com` headful, screenshot, confirm no
   "unsupported browser" wall.
3. **Login (headful)** — type creds, reach 2FA/feed, **save cookies.json**.
4. **Cookie fast-path** — delete password, re-run, confirm it loads from cookies
   headless and lands logged-in.
5. **Scrape** — implement §6, print names. Tune selectors against real DOM.
6. **Scroll-to-load** — add the virtualization loop, confirm full list.
7. **Polish** — exit codes, stderr/stdout split, `--out`, README.

Each step is independently runnable and visibly verifiable — no big-bang.

---

## 8. One runnable check

`threads.js` exports a pure `pickName({title, ariaLabel})` helper (clean title
wins, comma-split aria-label is the lossy fallback); the rest is browser-bound.
Drop a `test_parse.mjs` with `node:assert`:

```js
import assert from 'node:assert';
import { pickName } from './src/threads.js';
// clean title wins — commas in the name are PRESERVED:
assert.equal(pickName({ title: 'Smith, Jane', ariaLabel: 'Smith, Jane, You: hi' }), 'Smith, Jane');
assert.equal(pickName({ title: 'Mom',         ariaLabel: 'Mom, ok see you'      }), 'Mom');
// fallback only when no title — lossy on commas (documented ceiling):
assert.equal(pickName({ title: '', ariaLabel: 'Work Group, Alice sent a photo' }), 'Work Group');
assert.equal(pickName({ title: '', ariaLabel: '' }), '');
console.log('ok');
```

`node test_parse.mjs` → guards name extraction (incl. the comma-in-name case)
without a browser or framework. Everything else is verified by eyeballing
step 2–6 output.

---

## 9. Risks & known ceilings

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| 2FA / checkpoint on login | High | headful first run, manual solve, cookie cache |
| Selectors break | Medium-High | isolated in `threads.js`, documented recovery |
| Account flagged for automation | Real, can't zero out | own account only, low frequency, stealth plugin, reuse cookies (don't re-login every run) |
| Cookies expire | Eventual | detect "logged out" → fall back to password login → re-save |
| Password leaks via shell history | Medium | document `$FB_PASS` env alternative |

---

## 10. Out of scope (YAGNI — add only if asked)

- Reading message *contents* (only thread names requested)
- Multi-account / profile switching
- Proxy rotation, headless-server deployment, scheduling
- Database / structured output (stdout lines pipe fine; add `--json` later if needed)
- Handling Messenger's "Marketplace"/"Requests" sub-folders

---

### TL;DR

Stealth Puppeteer + persisted cookies. First run headful to clear 2FA by hand,
then headless forever. Scrape thread names by `role`/`aria-label`, scroll to
de-virtualize the list, print to stdout. 4 files, 3 deps, `parseArgs` for the
CLI. The selectors are the part that rots — they live alone in `threads.js`.
