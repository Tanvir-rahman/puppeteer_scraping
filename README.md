<div align="center">

# FB Multi-Account Scraper &amp; Manager

### A stealth Puppeteer CLI that scrapes and manages your Facebook Messenger conversations — single account or a whole authorized fleet.

[![Node](https://img.shields.io/badge/Node-%E2%89%A520.6-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-25.x-40B5A4?logo=puppeteer&logoColor=white)](https://pptr.dev)
[![Stealth](https://img.shields.io/badge/puppeteer--extra-stealth-blueviolet)](https://github.com/berstend/puppeteer-extra)
[![TOTP 2FA](https://img.shields.io/badge/2FA-TOTP%20auto--fill-orange)](#-two-factor-auth-totp)
[![License](https://img.shields.io/badge/License-ISC-lightgrey)](#-license)

```bash
fb-scraper                       # reads creds from .env, prints thread names
```
```text
Mom
Work crew
College reunion
…
```

</div>

> **Personal automation of accounts you own or are authorized to operate.** Facebook
> actively fights bots, so this is inherently fragile by nature — see [Known limits](#-known-limits-by-design).

---

## ✨ Features

- 🧩 **One-command Messenger scrape** — logs in, opens Messenger, prints every thread name to `stdout`.
- 🥷 **Stealth by default** — `puppeteer-extra-plugin-stealth` to reduce automation fingerprints.
- 🔐 **Auto 2FA (TOTP)** — generates and enters authenticator codes from a secret in `.env`.
- 🍪 **Cookie + profile reuse** — log in once, then run **headless** forever (no password, no window).
- 👥 **Multi-account farm** — `farm.js` orchestrates a fleet: concurrency, jittered stagger, retry/backoff, ban detection, per-account result files.
- 🧪 **Pipe-friendly** — thread names on `stdout`, all logs/prompts on `stderr`, meaningful exit codes.

## 📑 Table of contents

- [Quick start](#-quick-start)
- [Install](#-install)
- [Usage & flags](#-usage--flags)
- [First run (read this)](#-first-run-read-this)
- [Two-factor auth (TOTP)](#-two-factor-auth-totp)
- [Stop getting reCAPTCHA](#-stop-getting-recaptcha-persistent-profile)
- [Multiple accounts](#-multiple-accounts)
- [Account farm (at scale)](#-account-farm-at-scale)
- [Security notes](#-security-notes)
- [Known limits](#-known-limits-by-design)
- [Architecture](#-architecture)
- [Tests](#-tests)
- [License & legal](#-license)

## 🚀 Quick start

```bash
pnpm install                    # deps + a matched Chromium
cp .env.example .env            # add FB_USER / FB_PASS / FB_TOTP
node src/cli.js                 # first run opens a window for 2FA; later runs go headless
```

## 📦 Install

```bash
pnpm install          # installs deps + downloads a matched Chromium
pnpm link --global    # optional: makes `fb-scraper` runnable from anywhere
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

**Requirements:** Node ≥ 20.6 (uses `process.loadEnvFile`), pnpm, macOS/Linux.

## 🛠 Usage & flags

```bash
fb-scraper [--username <user>] [--pass <pass>] [--totp <secret>] \
          [--profile <dir>] [--proxy <url>] [--out cookies.json] \
          [--headful] [--fresh] [--manual]
```

| Flag | Env | What it does |
|------|-----|--------------|
| `--username` | `$FB_USER` | FB email / phone / username |
| `--pass` | `$FB_PASS` | FB password |
| `--totp` | `$FB_TOTP` | Authenticator secret — auto-generates 2FA codes |
| `--profile` | `$FB_PROFILE` | Persistent browser profile dir (device trust → no reCAPTCHA) |
| `--proxy` | `$FB_PROXY` | Per-account proxy `http://user:pass@host:port` |
| `--out` | — | Cookie cache path (default `./cookies.json`) |
| `--json` | — | Also write scraped names + count + timestamp to this JSON file |
| `--headful` | — | Show the browser window (auto-forced on first run) |
| `--fresh` | — | Ignore saved cookies and log in again |
| `--manual` | — | **You** log in by hand in the window (best vs CAPTCHA) — no auto-typing |

**Output contract:** thread names → `stdout`, everything else → `stderr`, so it pipes cleanly:

```bash
fb-scraper 2>/dev/null | grep Mom
```

**Exit codes:** `0` ok · `1` bad args · `2` login/checkpoint failed · `3` scrape found nothing.

## 🔑 First run (read this)

Facebook now front-loads a **passkey/2FA chooser** that a script cannot click past — a
human gesture is required **once**. The flow is *semi-automatic*:

1. Run it — credentials (and TOTP, if set) are **auto-filled**, and the
   **"Authentication app"** method is **auto-selected** for you.
2. The browser window is yours: click **Continue**, type the 6-digit code, land on the
   feed, then **press Enter** in the terminal.
3. Cookies are saved to your `--out` file and the `--profile` becomes trusted.

```bash
node src/cli.js --fresh --profile ./fb-profile --out cookies.json
```

**Every run after that is fully headless** — no password, no window — until the cookies
expire. That cookie-reuse model is the whole point: log in by hand once, automate forever.

> 💡 Prefer to drive the entire first login yourself? Add `--manual` — nothing is typed
> or clicked for you, which is the most reliable path past a stubborn CAPTCHA.

## 🔐 Two-factor auth (TOTP)

Put the **authenticator secret** in `.env` and login codes are generated and entered
automatically — no phone, no copy-paste:

```dotenv
FB_TOTP="JBSW Y3DP EHPK 3PXP"   # base32 secret shown when you add FB to an authenticator app
```

Spaces/dashes are stripped. It's the same secret behind your Google Authenticator / Authy
entry — from FB **Settings → Password and security → Two-factor authentication →
Authenticator app** (reveal / "set up key"). With it set, the login flow also routes the
passkey chooser to **Authentication app** and clicks through "Trust this device" / "Continue"
checkpoints — stopping for your one manual gesture only where Facebook demands it.

## 🛡 Stop getting reCAPTCHA (persistent profile)

Facebook challenges fresh/automated browsers with reCAPTCHA. A **persistent profile dir**
keeps the whole browser session + device trust, so once you log in (solving the captcha
that one time), Facebook stops challenging it.

```bash
# 1. one-time: log in by hand into the profile (window opens; solve captcha + 2FA)
node src/cli.js --profile ./fb-profile --manual --fresh

# 2. every run after: reuses the profile — no login, no captcha
node src/cli.js --profile ./fb-profile
```

Set it once in `.env` so you don't pass the flag each time:

```dotenv
FB_PROFILE="./fb-profile"
```

The profile dir is gitignored — it holds a live session, so **treat it like a password**.

## 👥 Multiple accounts

Each account gets its own **profile dir** (`--profile`) and **cookie file** (`--out`).
That's the whole isolation: separate sessions, separate device trust, no
cross-contamination. No special mode — run the CLI once per account with different paths.

```bash
# one-time: log in by hand into each account's own profile (solve captcha/2FA once)
node src/cli.js --profile ./fb-profile-alice --out cookies-alice.json --manual --fresh
node src/cli.js --profile ./fb-profile-bob   --out cookies-bob.json   --manual --fresh

# afterwards: headless collect, per account
node src/cli.js --profile ./fb-profile-alice --out cookies-alice.json
node src/cli.js --profile ./fb-profile-bob   --out cookies-bob.json
```

Loop over them in a shell script (names go to stdout, so tag each account on stderr):

```bash
for acct in alice bob carol; do
  echo "== $acct ==" >&2
  node src/cli.js --profile "./fb-profile-$acct" --out "cookies-$acct.json"
done
```

**Rules of thumb**

- One `--profile` + one `--out` **per** account — never shared (they'd overwrite each other's session).
- Gitignore the new paths — add `fb-profile-*` and `cookies-*.json`.
- Keep frequency low and stagger runs; logging into many accounts back-to-back from one IP is exactly what trips FB's defenses.

## 🏭 Account farm (at scale)

For a fleet you own or are **authorized to operate**, `src/farm.js` runs the
single-account CLI across every account as an **isolated subprocess**, with concurrency
control, jittered stagger, retry/backoff, ban detection, and per-account result files.

> ⚠️ **Authorized use only.** Automating Facebook violates its ToS; doing it across many
> accounts escalates account-ban and legal exposure (message data is personal data). This
> tooling assumes an authorized client-ops context.

**1. Describe your accounts** in `accounts.json` (gitignored — holds live creds):

```bash
cp accounts.example.json accounts.json   # then edit
```

```json
[
  { "id": "alice", "username": "alice@example.com", "pass": "...",
    "totp": "JBSW Y3DP EHPK 3PXP", "proxy": "http://user:pass@host:port" }
]
```

`id` is required (names the per-account profile dir, cookie file, and result file).
`totp` and `proxy` are optional. **Give every account its own sticky proxy** — sharing
one IP across accounts is the fastest way to get a whole batch flagged.

**2. One-time human login per account** (builds device trust so later headless runs aren't challenged):

```bash
node src/cli.js --profile ./profiles/alice --out ./cookies/alice.json \
  --proxy 'http://user:pass@host:port' --fresh
```

**3. Run the farm** (headless, reuses each account's cookies):

```bash
pnpm farm                      # reads ./accounts.json
# or: node src/farm.js path/to/accounts.json
```

**Tune via env:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `FARM_CONCURRENCY` | `5` | Accounts running at once (raise carefully — more load + detection surface) |
| `FARM_MAX_RETRIES` | `2` | Retries on transient failure (`auth_fail` / `crash`) before quarantine |
| `FARM_TIMEOUT_MS` | `300000` | Kill a hung account run after 5 min |
| `FARM_OUT_DIR` | `./farm-results` | Where per-account results land |

**Output (observability).** Each account streams its result to `farm-results/<id>.json`
**the moment it finishes** — a crash or Ctrl-C mid-batch keeps every account that already
completed:

```json
{ "id": "alice", "status": "ok", "attempts": 1, "threadCount": 42,
  "names": ["Mom", "Work crew", "..."], "stderrTail": "...", "finishedAt": 1750000000000 }
```

Plus `farm-results/_summary.json` (counts by status) and `quarantine.json` (banned /
repeatedly-failed accounts, skipped next run until you remove them).

| Status | Meaning |
|--------|---------|
| `ok` | Scraped thread names |
| `empty` | Selectors rotted or empty inbox |
| `auth_fail` | Challenge / stale cookies / possible ban |
| `banned` | FB said disabled / suspended |
| `crashed` | Timeout / OOM / killed |

<details>
<summary><strong>What the farm does NOT do — ceilings by design</strong></summary>

These need infra beyond one box; wire them in as scale and proxy/browser budget grow:

- **Proxy-pool rotation / health checks** — each account has one sticky proxy; no pool that rotates or evicts dead IPs. Bring a managed residential/mobile proxy provider.
- **Per-account anti-detect fingerprints** — all accounts share the stealth plugin defaults. True isolation needs an anti-detect browser (Multilogin/GoLogin/Kameleo) or a fingerprint-injection layer.
- **Multi-machine / distributed workers** — one host with `FARM_CONCURRENCY` slots. 200+ continuous wants a queue (Redis/SQS) and a worker pool across machines; this orchestrator is the per-worker unit, not the cluster.
- **Account warming** — brand-new accounts still need the one-time human login and should be aged before heavy automation.
- **CAPTCHA solving** — an unattended challenge can't be auto-solved; a flagged account lands in quarantine for a human to clear.

</details>

## 🔒 Security notes

- A password on the command line is visible in shell history and `ps`. Prefer the
  `$FB_USER` / `$FB_PASS` env vars — the CLI reads them automatically:

  ```bash
  export FB_USER='you@example.com'
  read -rs FB_PASS; export FB_PASS   # type password, no echo
  fb-scraper                           # no creds on the command line
  ```
- `cookies.json`, profile dirs, and `accounts.json` are **live sessions / credentials** —
  treat like passwords. All are gitignored.

## 🧱 Known limits (by design)

- **Login can't be fully automated** — Facebook's passkey/2FA chooser needs one human
  gesture per account. The design leans on cookie reuse, not repeated logins.
- **Selectors rot** — Messenger's DOM is obfuscated and changes. If a run prints nothing
  (exit `3`), run `--headful`, inspect a conversation row in DevTools, and update the
  selectors in `src/threads.js` (isolated there on purpose).
- **Account risk** — automating FB violates its ToS. Use your own / authorized accounts,
  keep frequency low, and reuse cookies rather than logging in every run.

## 🗂 Architecture

```text
src/cli.js          arg parsing, orchestration, stdout (single account)
src/auth.js         login + cookie load/save (browser.cookies API)
src/checkpoints.js  automated login: creds + TOTP 2FA + passkey-chooser routing + checkpoints
src/threads.js      navigate Messenger + scrape names (the fragile selectors)
src/humanize.js     jittered timing + step-scroll helpers (human-behavior layer)
src/farm.js         multi-account orchestrator (concurrency, retry, ban detect, observability)
test_parse.mjs      unit test for name extraction
test_farm.mjs       unit test for farm decision logic (classify/retry/backoff/ban)
```

## ✅ Tests

```bash
pnpm test       # node test_parse.mjs && node test_farm.mjs
```

## 📄 License

ISC. **For personal use on accounts you own or are authorized to operate only.** You are
responsible for complying with Facebook's Terms of Service and applicable law; message
data is personal data.
