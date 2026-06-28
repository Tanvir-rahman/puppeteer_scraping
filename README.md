# pptscript

CLI that logs into **your own** Facebook account with Puppeteer, opens Messenger,
and prints every conversation (thread) name to the terminal.

```bash
pptscript --username you@example.com --pass 'yourpassword'
# → prints thread names, one per line
```

> Personal automation of your own account only. Facebook actively fights bots, so
> this is inherently fragile — see *Known limits* below.

## Install

```bash
pnpm install          # installs deps + downloads a matched Chromium
pnpm link --global    # optional: makes `pptscript` runnable from anywhere
```

If Chromium didn't download (pnpm blocks build scripts by default):

```bash
pnpm approve-builds   # tick puppeteer
# or: pnpm rebuild puppeteer
```

Verify it landed:

```bash
node -e "import('puppeteer').then(p=>console.log(p.default.executablePath()))"
```

## Usage

```
pptscript --username <user> --pass <pass> [--headful] [--out cookies.json]

--username   FB email / phone / username   (or $FB_USER env)
--pass       FB password                    (or $FB_PASS env)
--headful    show the browser window        (forced automatically on first run)
--fresh      ignore saved cookies + log in again (forces a window for 2FA)
--manual     YOU log in by hand in the window (best vs CAPTCHA) — no auto-typing
--out        cookie cache path (default ./cookies.json, CWD-relative)
```

**Hitting CAPTCHA?** Auto-filling credentials looks robotic and trips FB's
defenses. Log in by hand instead — open the window, type everything yourself,
solve the CAPTCHA/2FA, press Enter. Cookies are saved; later runs go headless.

```bash
node src/cli.js --manual --fresh    # window opens at login; you do it all
node src/cli.js                     # afterwards: headless, no login
```

Re-login from scratch (stale cookies / switch account):

```bash
node src/cli.js --fresh          # ignores cookies.json, opens window, re-does 2FA
# equivalent one-off: rm cookies.json && node src/cli.js
```

Credentials come from `$FB_USER` / `$FB_PASS` when the flags are omitted (flags
win if both are given). Prefer env so the password never hits shell history:

```bash
export FB_USER='you@example.com'
read -rs FB_PASS; export FB_PASS   # type password, no echo
pptscript                           # no creds on the command line
```

stdout is **thread names only** — logs and prompts go to stderr, so it pipes:

```bash
pptscript --username x --pass y 2>/dev/null | grep Mom
```

Exit codes: `0` ok · `1` bad args · `2` login/checkpoint failed · `3` scrape found nothing.

## First run (important)

The **first** run opens a real browser window (no cookie cache yet):

1. It types your credentials and submits.
2. Facebook will usually show **2FA** and/or a **checkpoint / "Trust this device"** screen.
3. Solve it in the window, click through **Trust / Continue** until the chat list
   appears, then **press Enter** in the terminal.
4. The session cookies are saved to `cookies.json`.

Every run after that loads `cookies.json` and runs **headless** — no password, no
window — until the cookies expire (then it asks you to re-run with `--headful`).

## Security notes

- A password on the command line is visible in shell history and `ps`. Prefer
  the `$FB_USER` / `$FB_PASS` env vars (above) — the CLI reads them automatically.
- `cookies.json` is a live session — treat it like a password. It's gitignored.

## Known limits (by design, not bugs)

- **Login can't be fully automated** — 2FA / checkpoints need a human once. That's
  why the design leans on cookie reuse, not repeated logins.
- **Selectors rot** — Messenger's DOM is obfuscated and changes. If a run prints
  nothing (exit 3), run `--headful`, inspect a conversation row in DevTools, and
  update the selectors in `src/threads.js` (isolated there on purpose).
- **Account risk** — automating FB violates its ToS. Use your own account, keep
  frequency low, and reuse cookies rather than logging in every run.

## Layout

```
src/cli.js      arg parsing, orchestration, stdout
src/auth.js     login + cookie load/save (browser.cookies API)
src/threads.js  navigate Messenger + scrape names (the fragile selectors)
test_parse.mjs  unit test for name extraction
```

## Test

```bash
pnpm test       # node test_parse.mjs
```
