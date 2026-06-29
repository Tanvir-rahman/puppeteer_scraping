# Learn Puppeteer Scraping — From Zero, Using This Project

This is a teaching walkthrough. It assumes you know basic JavaScript (variables,
functions, `async/await`) but **nothing** about browser automation or scraping.
By the end you'll understand every line of this project and be able to write your
own scraper.

We learn by reading **this exact codebase** (`pptscript` — a CLI that logs into
Facebook and prints your Messenger conversation names). Every concept is tied to a
real file and line you can open right now.

---

## Table of contents

1. [The big picture: what is Puppeteer?](#1-the-big-picture-what-is-puppeteer)
2. [The mental model: 4 objects you must understand](#2-the-mental-model-4-objects-you-must-understand)
3. [Setup: get it running on your machine](#3-setup-get-it-running-on-your-machine)
4. [Selectors — how you point at things on a page](#4-selectors--how-you-point-at-things-on-a-page)
5. [`page.evaluate` — the Node ↔ Browser boundary](#5-pageevaluate--the-node--browser-boundary)
6. [Waiting — the #1 source of scraper bugs](#6-waiting--the-1-source-of-scraper-bugs)
7. [Code tour: `cli.js` (the entry point)](#7-code-tour-clijs-the-entry-point)
8. [Code tour: `auth.js` (sessions & cookies)](#8-code-tour-authjs-sessions--cookies)
9. [Code tour: `checkpoints.js` (login automation & 2FA)](#9-code-tour-checkpointsjs-login-automation--2fa)
10. [Code tour: `threads.js` (the actual scrape)](#10-code-tour-threadsjs-the-actual-scrape)
11. [Anti-bot: stealth, headless, persistent profiles](#11-anti-bot-stealth-headless-persistent-profiles)
12. [Debugging a broken scraper](#12-debugging-a-broken-scraper)
13. [Exercises (do these to actually learn)](#13-exercises-do-these-to-actually-learn)
14. [Glossary](#14-glossary)

---

## 1. The big picture: what is Puppeteer?

**Puppeteer is a library that drives a real Chrome browser with code.** Instead of
*you* clicking and typing in Chrome, your Node.js script does it: open a page, type
in a box, click a button, read text off the screen.

Why drive a *real browser* instead of just downloading the HTML with `fetch`?

| Approach | When it works | When it fails |
|----------|---------------|---------------|
| `fetch(url)` + parse HTML | Page's content is in the initial HTML | Page builds content with JavaScript after load (React, etc.) |
| Puppeteer (real browser) | Almost always — it runs the JS, just like you | Slower, heavier, anti-bot systems can detect automation |

Facebook/Messenger is a giant JavaScript app. If you `fetch` the Messenger URL you
get an almost-empty HTML shell — the conversation list is drawn by JavaScript after
login. So we **must** use a real browser. That's why this project exists on Puppeteer.

> **Headless vs headful.** "Headless" = the browser runs invisibly, no window.
> "Headful" = a real window you can see. Same browser, same behavior — just whether
> pixels hit your screen. We use headful when a human needs to interact (solve a
> CAPTCHA), headless for automated runs.

---

## 2. The mental model: 4 objects you must understand

Almost all of Puppeteer is these four things. Learn them and the rest is detail.

```
Puppeteer ──launch()──▶ Browser ──newPage()──▶ Page ──$()/evaluate()──▶ Elements
```

1. **`puppeteer`** — the library. Its one important method is `launch()`.
2. **`Browser`** — one running Chrome process. Holds cookies, profiles, multiple tabs.
   - `browser.newPage()` → a tab
   - `browser.cookies()` / `browser.setCookie()` → read/write the session (we use this!)
   - `browser.close()` → kill it (always do this, or you leak processes)
3. **`Page`** — one tab. This is where 90% of your code lives.
   - `page.goto(url)` → navigate
   - `page.$(selector)` → find one element (returns `null` if missing)
   - `page.$$(selector)` → find all matching elements (array)
   - `page.waitForSelector(selector)` → pause until an element appears
   - `page.evaluate(fn)` → run JS *inside the page* and get the result back
   - `page.locator(sel).fill(text)` → modern, auto-waiting way to type into a field
4. **`ElementHandle`** — a reference to one DOM element living in the browser.
   - `el.click()`, `el.type('hi')`, `el.evaluate(e => e.textContent)`

See all four in `src/cli.js`:

```js
const browser = await puppeteer.launch({ headless: !headful, /* ... */ }); // Browser
const page = await browser.newPage();                                       // Page
await page.setViewport({ width: 1280, height: 900 });
// ...
await browser.close();
```

The single most important mental split: **your Node code and the page's JavaScript
are two different worlds.** They run in different processes and can't see each
other's variables. The only bridge is `page.evaluate` (section 5). Internalize this
early — it's the thing beginners trip on constantly.

---

## 3. Setup: get it running on your machine

This project uses `pnpm` (a faster npm) and ES modules (`"type": "module"` in
`package.json`, so files use `import`, not `require`).

```bash
cd /Users/pathaoltd/personal/puppeteer_scraping
pnpm install            # installs puppeteer + plugins AND downloads a matched Chromium
```

**Gotcha:** pnpm blocks package "build scripts" by default for safety, and Puppeteer
uses one to download Chromium. If the browser didn't download:

```bash
pnpm approve-builds     # tick "puppeteer", confirm
# or force it:
pnpm rebuild puppeteer
```

Verify Chromium actually landed:

```bash
node -e "import('puppeteer').then(p=>console.log(p.default.executablePath()))"
# prints a path to a Chromium binary → good. Throws → re-run approve-builds.
```

First run (opens a window — that's expected, more in section 8):

```bash
node src/cli.js --manual --fresh
```

---

## 4. Selectors — how you point at things on a page

A **selector** is a string that describes which element(s) you mean, using CSS
selector syntax (the same thing CSS uses to style elements). This is the core skill
of scraping — everything else is plumbing.

| Selector | Means |
|----------|-------|
| `div` | every `<div>` |
| `.title` | every element with `class="title"` |
| `#main` | the element with `id="main"` |
| `input[name="email"]` | `<input>` whose `name` attribute is `email` |
| `a[href*="/messages/"]` | `<a>` whose `href` *contains* `/messages/` (`*=` = "contains") |
| `[role="grid"] [role="row"]` | any `role="row"` element *inside* a `role="grid"` element |

That last pattern is everywhere in this codebase. Look at `src/threads.js:8`:

```js
const ROW_SELECTOR = '[role="grid"] [role="row"]';
```

This says: "find the conversation grid, then every row inside it." Each row is one
conversation.

**Why `role=` and not class names?** Open Facebook in DevTools and you'll see classes
like `class="x1n2onr6 x1ja2u2z"` — randomly-generated garbage that changes on every
deploy. You can't rely on those. But `role="row"` is an **ARIA accessibility
attribute** that Facebook keeps stable because screen readers depend on it. **Lesson:
prefer stable attributes (`role`, `aria-label`, `name`, `href` patterns) over CSS
classes when scraping a hostile, obfuscated site.**

Comma in a selector = "OR". See `src/auth.js:15`:

```js
const CHATLIST_SELECTOR = '[role="grid"] [role="row"], a[href*="/messages/t/"], [role="navigation"] a[href*="/t/"]';
```

This matches *any* of three things — because Facebook's layout differs between
desktop/mobile/logged-in states, and we want "logged in" to be true if **any** of
these chat-list signals is present. Robustness through alternatives.

---

## 5. `page.evaluate` — the Node ↔ Browser boundary

This is the concept that separates people who "get" Puppeteer from people who fight
it. Read this section twice.

`page.evaluate(fn)` ships the function `fn` **into the browser**, runs it there
(where `document`, `window`, the DOM all exist), and sends the **return value** back
to Node. The return value must be JSON-serializable — you can return strings,
numbers, arrays, plain objects. You **cannot** return a DOM element (it doesn't exist
in Node).

Look at `src/threads.js:72`, the function that actually reads the conversation rows:

```js
function extractRowsInPage() {
  const rows = document.querySelectorAll('[role="grid"] [role="row"]');
  const out = [];
  for (const row of rows) {
    const titleSpan = row.querySelector('span[dir="auto"]');
    const link = row.querySelector('a[role="link"][aria-label]');
    out.push({
      title: titleSpan ? titleSpan.textContent : '',
      ariaLabel: link ? link.getAttribute('aria-label') : '',
    });
  }
  return out;   // plain array of {title, ariaLabel} → serializes back to Node
}
```

And it's called like this (`src/threads.js:45`):

```js
rows = await page.evaluate(extractRowsInPage);
```

Three rules you must obey, all visible above:

1. **The function runs in the browser.** `document` exists there. It does *not* exist
   in your Node file outside `evaluate`.
2. **No closures over Node variables.** The function is *stringified* and re-created
   inside the browser — it loses access to anything from your Node scope. The comment
   at `threads.js:69` says exactly this: *"Must be self-contained (no closures over
   Node vars)."* If you need to pass a value in, pass it as an argument:
   `page.evaluate((x) => ..., myNodeVar)` — see `checkpoints.js:74` where the regex
   source string is passed in that way.
3. **Only serializable data comes back.** Notice we don't return the DOM rows — we
   return plain `{title, ariaLabel}` objects. The DOM stays in the browser.

**Design lesson from this repo:** `extractRowsInPage` returns *raw* data, and the
*decision* of which name to use happens back in Node in a separate pure function,
`pickName` (`threads.js:15`):

```js
export function pickName({ title, ariaLabel }) {
  const t = title && title.trim();
  if (t) return t;                              // prefer the clean title
  if (ariaLabel) return ariaLabel.split(',')[0].trim();  // fallback, lossy
  return '';
}
```

Why split the work? Because `pickName` is pure Node — no browser, no DOM — so it can
be **unit-tested** without launching a browser at all. That's what `test_parse.mjs`
does. **Keep your messy DOM-reading thin, and put real logic in pure, testable
functions.**

---

## 6. Waiting — the #1 source of scraper bugs

A web page is not ready the instant `goto` returns. JavaScript keeps running, content
loads later, things animate in. If you read the DOM too early you get nothing. **Most
"my scraper randomly fails" bugs are waiting bugs.**

There are good and bad ways to wait:

❌ **Bad:** `await sleep(5000)` — guessing. Too short → flaky. Too long → slow. Never
the right number.

✅ **Good:** `page.waitForSelector(sel)` — waits for a *specific thing to exist*, then
continues immediately. See `auth.js:31`:

```js
export function isLoggedIn(page) {
  return page
    .waitForSelector(CHATLIST_SELECTOR, { timeout: LOGIN_PROBE_MS })  // wait up to 30s
    .then(() => true)     // it appeared → logged in
    .catch(() => false);  // timed out → not logged in
}
```

This is a beautiful pattern: "wait for the chat list; if it shows up we're logged in,
if it never does we're not." The wait *is* the test.

You'll still see some `sleep()` calls in this codebase (`threads.js:33`,
`checkpoints.js:110`). Those are deliberate: after a scroll or a form submit, Facebook
needs a beat to *hydrate* newly-loaded rows, and there's no single selector that means
"hydration finished." When you can't name a precise signal, a short settle-sleep is a
pragmatic fallback — but reach for `waitForSelector` first, always.

> **Never infer state from the URL.** `auth.js:13` warns: *"Login state == chat list
> is present. NEVER infer from URL — FB bounces through /login, /checkpoint/,
> /two_step_verification/."* The URL lies during multi-step flows. Wait for a DOM
> element that proves the state you care about.

---

## 7. Code tour: `cli.js` (the entry point)

`src/cli.js` is the conductor. It does five things, in order. Read it top to bottom
with this map:

**a) Load credentials (lines 18–27).** It reads `.env` and makes it authoritative
over stale shell `export`s. The trick — snapshot shell values, delete them, load
`.env`, then restore only if `.env` didn't set them — exists because Node's
`loadEnvFile` won't overwrite an already-set var. You don't need to memorize this;
just know **credentials come from `.env` or env vars, not hardcoded.** Good security
hygiene — passwords never live in source.

**b) Parse arguments (lines 32–53).** Uses Node's *built-in* `parseArgs` (no
dependency needed) to read `--username`, `--headful`, `--fresh`, etc. Note lines
49–51: a flag wins if you pass it, otherwise it falls back to an env var. Flexible
without being complex.

**c) Decide headless vs headful (line 67):**

```js
const headful = opts.headful || opts.fresh || opts.manual || !fs.existsSync(opts.out);
```

Read it as English: *show a window if you asked for one, OR if you're forcing a fresh
login, OR doing a manual login, OR there's no saved cookie file yet.* The logic
encodes the project's core idea: **the first login needs a human (so, a window);
every run after reuses cookies and can be invisible.**

**d) Launch and orchestrate (lines 73–93):**

```js
const browser = await puppeteer.launch({
  headless: !headful,
  userDataDir: profile || undefined,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
// ...
await ensureLoggedIn(browser, page, { ...opts, headful });   // auth.js
const names = await collectThreadNames(page);                // threads.js
for (const name of names) process.stdout.write(name + '\n');
await browser.close();
```

That's the whole program: launch → log in → scrape → print → close. Everything else
is the *how* of those two middle steps.

**e) Error handling & exit codes (lines 94–99).** Note the discipline here, worth
copying into your own tools:

- **stdout = data only** (the thread names). **stderr = logs, prompts, errors.** That's
  why the file header says `pptscript ... 2>/dev/null | grep Mom` works — you can pipe
  the clean data and throw away the chatter. Look: every status message uses
  `process.stderr.write`, only names use `process.stdout.write`.
- **Exit codes carry meaning:** `0` ok · `1` bad args · `2` login failed · `3` scrape
  found nothing. A script calling this tool can branch on *why* it failed. The custom
  `AuthError` class (`auth.js:22`) even carries its own exit code.

---

## 8. Code tour: `auth.js` (sessions & cookies)

The hardest part of scraping a login-walled site isn't the scrape — it's **getting
and staying logged in.** This file is the strategy. The strategy in one sentence:
**log in by hand once, save the cookies, reuse them forever (until they expire).**

### What is a cookie session?

When you log into Facebook, the server hands your browser **cookies** — little tokens
that say "this browser is authenticated as Tanvir." Every later request includes
them, so you stay logged in. If we *save those cookies to a file* and *load them into
a fresh browser*, that browser is logged in too — no password, no 2FA. That's the
entire game.

Save (`auth.js:47`):

```js
async function saveCookies(browser, out) {
  const cookies = await browser.cookies();           // v23+ browser-level API
  fs.writeFileSync(out, JSON.stringify(cookies, null, 2));   // → cookies.json
}
```

Load (`auth.js:70`):

```js
if (cookies) {
  await browser.setCookie(...cookies.map(sanitize));       // inject saved session
  await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) { /* we're in, no login needed */ }
}
```

> **Order matters (subtle bug warning).** The comment at `auth.js:65` flags it: you
> must `setCookie` **before** `goto`. If you navigate first, that first request goes
> out with no cookies and Facebook bounces you to the login wall. Set the session,
> *then* visit. This kind of ordering bug is classic in auth flows.

**`sanitize` (line 52)** trims each cookie down to only the fields
`setCookie` accepts (`COOKIE_FIELDS`, line 20). `browser.cookies()` returns extra
fields like `size`/`session` that make `setCookie` throw. Filtering input to what an
API actually accepts is a small but real robustness habit.

### `ensureLoggedIn` — the decision tree (line 62)

This one function is the whole login policy. It tries the cheapest path first and
escalates only as needed:

1. **Cookie fast-path** (lines 68–78): saved cookies exist → inject them → are we in?
   Yes → done (this is the common case, runs headless, ~instant).
2. **Persistent profile session** (lines 83–90): even with no `cookies.json`, a
   `--profile` dir may already hold a live session. Check before logging in.
3. **Manual login** (lines 96–110): open the real login page, let the **human** type
   everything and solve the CAPTCHA, press Enter when done. Most reliable against
   anti-bot defenses *because nothing is automated* — it looks exactly like a person.
4. **Automated login** (lines 112–122): types creds, auto-enters 2FA from a TOTP
   secret, clicks through checkpoints (that's `checkpoints.js`, next section).
5. **Headful fallback** (lines 126–136): automation stalled (usually reCAPTCHA)? If a
   window is open, ask the human to finish, then continue.

**The teaching point:** a good scraper login flow is a *ladder of fallbacks*, cheap to
expensive, automated to human. Don't try to fully automate a hostile login — leave a
human escape hatch.

### `waitForFacebookLogin` (line 144) — don't navigate mid-login

When a 2FA / "approve on your phone" prompt is pending, the wrong move is to navigate
the page — that throws away the in-progress login. So this function *polls the current
page without navigating*, for up to 2 minutes, until it sees the logged-in Facebook
chrome (the top banner). Patience over force. Note it checks `new URL(page.url())
.pathname` (the path only) deliberately — line 148 explains the home page can carry a
`?checkpoint_src=...` query param that must **not** be mistaken for a challenge page.

---

## 9. Code tour: `checkpoints.js` (login automation & 2FA)

This is the automated-login path: fill the form, handle 2-factor auth, and click
through Facebook's post-login "checkpoint" screens until the chat list appears.

### Filling the form (line 43)

```js
async function fillLogin(page, username, pass) {
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });
  await page.locator('input[name="email"]').fill(username);
  await page.locator('input[name="pass"]').fill(pass);
  const btn = await page.$('button[name="login"], button[type="submit"]');
  if (btn) await btn.click();
  else await page.keyboard.press('Enter');
}
```

Two real-world lessons baked in here:

- **`locator().fill()` vs `page.type()`** (comment at line 45): `fill` sets the whole
  value in one shot. `page.type` simulates per-character keystrokes — but Facebook's
  form *re-renders while you type* and drops characters. When a typed value comes out
  mangled, `fill` is the fix.
- **Click button *or* press Enter** — the submit button's selector isn't guaranteed,
  so there's a fallback. Defensive.

### 2FA with TOTP (line 54)

TOTP = the 6-digit code your authenticator app (Google Authenticator/Authy) shows,
which rotates every 30 seconds. It's derived from a **secret** + the current time. If
you have the secret, you can generate the same code in code — no phone needed:

```js
const { otp } = await TOTP.generate(secret.replace(/[\s-]/g, ''));  // strip spaces/dashes
await el.type(otp, { delay: 60 });
```

The secret is the base32 string Facebook showed when you set up the authenticator
(`FB_TOTP` in `.env`). Note `CODE_INPUTS` (line 17) lists *three* possible selectors
for the code field — Facebook has used different ones over time, so we try them all.

### The checkpoint loop (line 106) — the heart of `automatedLogin`

Facebook doesn't go login → done. It throws a variable sequence of screens: enter
code, "Trust this device?", "Continue", "Save your info?". You can't hardcode the
order. So the code runs a **state-machine loop**: look at what's on screen *right
now*, act on it, repeat.

```js
for (let round = 0; round < maxRounds; round++) {
  if (await fbHome(page)) break;          // success: top bar appeared, we're in
  if (/* reCAPTCHA present */) return false;  // can't auto-solve → hand to human
  const step = await currentStep(page);   // which screen are we on?
  if (step === 'login')      await fillLogin(page, username, pass);
  else if (step === 'code')  { await fillTotp(page, totpSecret); await clickContinue(page); }
  else if (step === 'continue') await clickContinue(page);
  else { /* loading splash — just wait it out */ }
  await sleep(3000);
}
```

`currentStep` (line 91) just probes the DOM: is there a code input? → `'code'`. A
password field? → `'login'`. A continue-ish button? → `'continue'`. Nothing
actionable? → `'none'` (probably a loading splash, so wait, don't bail).

**This loop pattern is gold for any messy multi-step web flow.** Don't script "do A,
then B, then C." Instead: "look at the page, handle whatever's there, loop." It
survives screens appearing in different orders or being skipped.

`clickContinue` (line 73) finds a button whose visible text matches a regex of known
button labels (`CONTINUE_TEXT`, line 24 — `continue|submit|trust this device|...`),
**and is actually visible** (`e.offsetParent !== null` filters out hidden elements).
Matching by visible text, not by a brittle selector, is what makes it robust to
Facebook's class-name churn.

### The `shot` debug helper (line 32)

```js
if (process.env.PPT_DEBUG_DIR) { await page.screenshot({ path: `${dir}/${name}.png` }); }
```

When automation lands somewhere unexpected, you can't see a headless browser. So set
`PPT_DEBUG_DIR=./debug` and the code dumps a screenshot + the page title/URL at each
step. **Build your own eyes into a headless scraper** — this single habit saves hours.

---

## 10. Code tour: `threads.js` (the actual scrape)

Finally, the scrape. By now we're logged in and sitting on Messenger. The job:
collect every conversation name. Two challenges make it interesting.

### Challenge 1: the list is *virtualized*

Messenger doesn't put all your conversations in the DOM at once. It keeps maybe ~20
rows in the DOM; as you scroll, it *unloads* the ones that scrolled away and *loads*
new ones. So you can't just read the DOM once — you'd get 20 names and miss the rest.

The fix (`collectThreadNames`, line 24): **scroll, read, accumulate into a `Set`,
repeat until no new names appear.**

```js
const seen = new Set();           // Set auto-dedupes, and survives rows unloading
let stable = 0;
for (let i = 0; i < MAX_SCROLL_ITERS && stable < STABLE_ROUNDS; i++) {
  const rows = await page.evaluate(extractRowsInPage);   // read what's currently loaded
  const before = seen.size;
  for (const raw of rows) { const name = pickName(raw); if (name) seen.add(name); }
  stable = seen.size === before ? stable + 1 : 0;        // no new names this round?
  await page.evaluate(scrollChatListInPage);             // scroll to load more
  await sleep(SCROLL_SETTLE_MS);                          // let new rows hydrate
}
return [...seen];
```

The loop's stop condition is the clever bit: **stop after 5 consecutive scrolls add
zero new names** (`STABLE_ROUNDS`, line 11) — that means we've hit the bottom. The
`MAX_SCROLL_ITERS` ceiling (line 10) is a safety net so a never-settling list can't
spin forever. *Always bound your loops* when scraping — pages misbehave.

### Challenge 2: an overlay eats mouse-wheel scrolls

Comment at line 35 — Messenger throws an end-to-end-encryption "restore your chats"
modal on a fresh device, and its dimming overlay swallows mouse/wheel events. So
instead of simulating a wheel scroll, the code sets `scrollTop` directly via JS, which
ignores the overlay (`scrollChatListInPage`, line 90):

```js
function scrollChatListInPage() {
  const row = document.querySelector('[role="grid"] [role="row"]');
  let el = row;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 20) {  // found the scrollable ancestor
      el.scrollTop = el.scrollHeight;              // jump to bottom
      return;
    }
    el = el.parentElement;
  }
}
```

It walks *up* from a row to find the real scroll container (the ancestor whose content
overflows its visible height), then jumps it to the bottom. **Lesson:** the scrollable
element is often not the one you'd guess — find it by its overflow property, and
prefer `scrollTop` over fake wheel events when overlays are in play.

### Resilience: surviving frame detaches

Both `evaluate` calls are wrapped in `try/catch` (lines 44, 59). Facebook occasionally
refreshes the session and *detaches the frame* mid-scrape, which throws "Attempted to
use detached Frame." Instead of crashing the whole run, the code catches it, waits for
the row selector to come back, and continues the loop. **A long-running scrape will
hit transient errors — catch and continue, don't let one hiccup kill a 2-minute job.**

---

## 11. Anti-bot: stealth, headless, persistent profiles

Facebook actively fights automation. Three defenses this project uses, and the *why*:

**1. The stealth plugin** (`cli.js:8,29`):

```js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
```

A vanilla Puppeteer browser leaks tells that it's automated — most famously
`navigator.webdriver === true`, plus odd values for plugins, languages, WebGL, etc.
Sites read these to detect bots. `puppeteer-extra-plugin-stealth` patches dozens of
these tells so the browser looks human. `--disable-blink-features=
AutomationControlled` (`cli.js:76`) removes another one.

**2. Persistent profile** (`userDataDir`, `cli.js:75`). A normal launch is a brand-new
browser with no history — which looks suspicious and triggers reCAPTCHA. A
`--profile ./fb-profile` dir makes Chrome reuse the *same* profile across runs:
cookies, local storage, device fingerprint, "this device is trusted." **Log in by hand
once into the profile, and Facebook stops challenging it.** The README calls this the
recommended setup, and it's the single most effective anti-CAPTCHA move here.

**3. Don't automate when you don't have to.** The whole architecture leans on *cookie
reuse over repeated logins*. Every login is a chance to trip a defense; a reused
session is invisible. The most robust scraper is the one that logs in least.

> **Ethics/ToS, plainly:** automating Facebook violates its Terms of Service and risks
> your account. This tool is built for *your own* account, low frequency, personal
> use. The defensive design (reuse sessions, human-in-the-loop, low volume) is also
> what keeps you under the radar. Don't point this at accounts you don't own, and
> don't crank the frequency.

---

## 12. Debugging a broken scraper

Scrapers break when the site changes its DOM. This will happen to you. Here's the
systematic fix, using this project's own escape hatches:

**Symptom: it prints nothing (exit code 3).** The selectors rotted. Do this:

1. **Run with a window:** `node src/cli.js --headful` (or `--manual --fresh`). Now you
   can *see* what the browser sees.
2. **Open DevTools** in that window (Cmd+Opt+I). Right-click a conversation row →
   Inspect.
3. **Check the assumptions in `threads.js`:** Is each row still `[role="row"]` inside
   `[role="grid"]`? Is the name still in a `span[dir="auto"]`? Is the link still
   `a[role="link"][aria-label]`? Facebook may have changed any of these.
4. **Update the selectors** in `threads.js` (lines 8, 73, 76–77) and
   `pickName`'s assumptions. They're deliberately isolated in one small file so the
   fragile part is easy to find and re-tune — that's *why* the scrape lives apart from
   the auth.
5. **For login problems**, set `PPT_DEBUG_DIR=./debug` and read the screenshots
   (section 9) to see exactly which screen the automation got stuck on.

**General debugging toolkit for any Puppeteer project:**

- `await page.screenshot({ path: 'debug.png' })` — see a headless page.
- `console.log(await page.content())` — dump the current HTML.
- `page.on('console', msg => console.log(msg.text()))` — pipe the *browser's*
  `console.log` out to your terminal (remember: browser and Node are separate worlds).
- Run headful and slow things down so you can watch.
- Test your selector live: in DevTools console,
  `document.querySelectorAll('[role="grid"] [role="row"]').length` — does it find your
  rows? If 0, your selector is wrong; fix it there before touching code.

---

## 13. Exercises (do these to actually learn)

Reading code teaches less than changing it. In rough order of difficulty:

1. **Easiest — count, not list.** Make the CLI also print, to stderr, how many threads
   it found. (Hint: `names.length` in `cli.js`.)
2. **Add a `--limit N` flag.** Stop scrolling once you've collected N names. (Touch
   `cli.js` arg parsing + `collectThreadNames`.)
3. **Scrape more than the name.** Extend `extractRowsInPage` to also grab the last
   message preview text and timestamp, and have `pickName`'s sibling return them.
   You'll practice the `evaluate` boundary and pure-function split.
4. **Output JSON.** Add `--json` so it prints `[{ "name": "..." }, ...]` instead of
   plain lines. Teaches you why the stdout/stderr split matters.
5. **Write a test.** Add a case to `test_parse.mjs` for `pickName` — e.g. a group name
   that legitimately contains a comma should come through whole from `title` but be
   truncated from `ariaLabel`. Run `pnpm test`.
6. **Hardest — new target.** Write a *brand-new* tiny scraper for a *simple, public*
   site you're allowed to scrape (e.g. `https://quotes.toscrape.com`, built for
   practice). Launch a browser, `goto`, `waitForSelector`, `evaluate` to pull the
   quotes, print them. No login, no anti-bot — just the core loop, so the fundamentals
   stick.

---

## 14. Glossary

- **Puppeteer** — Node library that controls a real Chrome browser with code.
- **Headless / headful** — browser running without / with a visible window.
- **Page** — one browser tab; where most of your code operates.
- **Selector** — a CSS-syntax string identifying element(s): `[role="row"]`,
  `input[name="email"]`.
- **`evaluate`** — run JS *inside the browser page* and return serializable data to
  Node. The one bridge between the two worlds.
- **ElementHandle** — a Node-side reference to a single DOM element in the browser.
- **Cookie session** — auth tokens the server gives your browser after login; saving
  and reloading them = staying logged in without re-entering a password.
- **TOTP** — time-based one-time password; the rotating 6-digit 2FA code, derivable in
  code from a shared secret.
- **Virtualized list** — a list that keeps only the visible rows in the DOM and
  loads/unloads as you scroll. Forces scroll-and-accumulate scraping.
- **Stealth plugin** — patches the automation "tells" (like `navigator.webdriver`)
  that anti-bot systems detect.
- **Checkpoint** — Facebook's post-login interstitial screens (2FA, "trust this
  device", "save your info").
- **`userDataDir` / persistent profile** — a folder where Chrome stores a reusable
  session + device trust across runs; the key anti-reCAPTCHA tool here.

---

### Where to go next

- Official docs: <https://pptr.dev> — the API reference for every method above.
- This repo's `README.md` — the *operator's* manual (how to run it); this doc is the
  *learner's* manual (how it works).
- Then do exercise 6: build something small from scratch. That's when it clicks.
