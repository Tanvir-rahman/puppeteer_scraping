#!/usr/bin/env node
// Account-farm orchestrator: run the single-account CLI across many accounts with
// concurrency control, jittered stagger, retry/backoff, ban detection, and
// per-account observability. Each account is an ISOLATED subprocess (own profile
// dir, own cookie file, own proxy) so one hung/crashed Chrome can't take down the
// run — and the OS reclaims its memory when it exits.
//
//   node src/farm.js [accounts.json]
//
// ceilings (NOT built here — by design, they need infra beyond one box):
//   * proxy-POOL rotation / health-checking — here each account has ONE sticky proxy
//   * per-account anti-detect FINGERPRINTS — here all share the stealth plugin defaults
//   * multi-MACHINE workers — here it's one host, FARM_CONCURRENCY slots
//   * account WARMING pipeline — fresh accounts still need a human first login
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { humanSleep, rand } from './humanize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.FARM_CLI || path.join(HERE, 'cli.js'); // overridable for tests

const cfg = {
  accountsFile: process.argv[2] || process.env.FARM_ACCOUNTS || './accounts.json',
  concurrency: Number(process.env.FARM_CONCURRENCY || 5),
  maxRetries: Number(process.env.FARM_MAX_RETRIES || 2),
  timeoutMs: Number(process.env.FARM_TIMEOUT_MS || 300000), // kill a hung account run
  outDir: process.env.FARM_OUT_DIR || './farm-results',
  profilesDir: process.env.FARM_PROFILES_DIR || './profiles',
  cookiesDir: process.env.FARM_COOKIES_DIR || './cookies',
  quarantineFile: process.env.FARM_QUARANTINE || './quarantine.json',
};

// ---- pure, unit-tested decision logic (see test_farm.mjs) ----------------------

// Map a CLI exit code to a status. Mirrors cli.js: 0 ok · 1 bad args · 2 login/
// checkpoint failed · 3 scrape empty. Anything else (incl. null from a kill) crashed.
export function classifyExit(code) {
  switch (code) {
    case 0: return 'ok';
    case 1: return 'bad_args';   // config error — retrying won't help
    case 2: return 'auth_fail';  // challenge / stale cookies / possible ban
    case 3: return 'empty';      // no rows — selectors rotted or genuinely empty
    default: return 'crashed';   // segfault / OOM / timeout kill
  }
}

// Retry only transient classes, bounded. bad_args is config; empty/ok/banned are
// terminal (retrying an empty scrape just burns proxy + risk).
export function shouldRetry(status, attempt, maxRetries) {
  if (status === 'auth_fail' || status === 'crashed') return attempt < maxRetries;
  return false;
}

// Exponential backoff with jitter, capped. attempt starts at 1.
export function backoffMs(attempt, capMs = 60000) {
  const base = Math.min(capMs, 1000 * 2 ** attempt);
  return base + rand(0, 1000); // jitter so retries don't synchronize across accounts
}

// Hard, unrecoverable account states FB spells out in text — quarantine immediately,
// never retry (retrying a disabled account is how you get the IP flagged too).
export function isHardBan(stderr) {
  return /account (?:has been )?disabled|we(?:'| ?ha)ve suspended|your account is locked|permanently (?:disabled|removed)/i.test(
    stderr || ''
  );
}

// ---- runtime ------------------------------------------------------------------

function loadAccounts(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${file}: expected a non-empty JSON array`);
  for (const a of raw) {
    if (!a.id) throw new Error(`account missing "id": ${JSON.stringify(a)}`);
  }
  return raw;
}

function loadQuarantine(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Run one account as a subprocess. Creds go via env (PPT_FARM=1 makes cli.js treat
// them as authoritative and skip .env). Returns {code, stdout, stderr, timedOut}.
function runAccount(acct) {
  const profile = path.join(cfg.profilesDir, acct.id);
  const cookies = path.join(cfg.cookiesDir, `${acct.id}.json`);
  const args = [CLI, '--profile', profile, '--out', cookies];
  if (acct.proxy) args.push('--proxy', acct.proxy);

  const env = {
    ...process.env,
    PPT_FARM: '1',
    FB_USER: acct.username || '',
    FB_PASS: acct.pass || '',
    FB_TOTP: acct.totp || '',
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, cfg.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// One account through its full retry lifecycle. Returns the result record.
async function processAccount(acct) {
  const startedAt = Date.now();
  let attempt = 0;
  let res;
  let status;
  while (true) {
    attempt++;
    res = await runAccount(acct);
    if (isHardBan(res.stderr)) {
      status = 'banned';
      break;
    }
    status = res.timedOut ? 'crashed' : classifyExit(res.code);
    if (status === 'ok' || !shouldRetry(status, attempt, cfg.maxRetries)) break;
    await sleep(backoffMs(attempt));
  }
  const names = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    id: acct.id,
    status,
    attempts: attempt,
    exitCode: res.code,
    timedOut: res.timedOut,
    threadCount: names.length,
    names,
    stderrTail: res.stderr.split('\n').slice(-8).join('\n'),
    startedAt,
    finishedAt: Date.now(),
  };
}

// Bounded-concurrency pool with jittered per-task stagger. Native, no p-limit dep.
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await humanSleep(200, 1500); // stagger starts so 200 accounts don't burst as one
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(lanes);
  return results;
}

function log(msg) {
  process.stderr.write(`[farm] ${msg}\n`);
}

// Persist ONE account's result the instant it finishes (not at end-of-batch), so a
// Ctrl-C or crash mid-run keeps every account that already completed. quarantine is
// a shared object — safe to mutate here because JS is single-threaded between awaits.
function finalizeResult(r, quarantine) {
  fs.writeFileSync(path.join(cfg.outDir, `${r.id}.json`), JSON.stringify(r, null, 2));
  if (r.status === 'banned' || (r.status === 'auth_fail' && r.attempts > cfg.maxRetries - 1)) {
    quarantine[r.id] = { reason: r.status, ts: r.finishedAt };
    fs.writeFileSync(cfg.quarantineFile, JSON.stringify(quarantine, null, 2));
  }
  log(`${r.id}: ${r.status} — ${r.threadCount} threads (${r.attempts} attempt(s))`);
}

async function main() {
  let accounts;
  try {
    accounts = loadAccounts(cfg.accountsFile);
  } catch (e) {
    log(e.message);
    process.exit(1);
  }
  for (const d of [cfg.outDir, cfg.profilesDir, cfg.cookiesDir]) fs.mkdirSync(d, { recursive: true });

  const quarantine = loadQuarantine(cfg.quarantineFile);
  const active = accounts.filter((a) => {
    if (quarantine[a.id]) {
      log(`skipping quarantined account ${a.id} (${quarantine[a.id].reason})`);
      return false;
    }
    return true;
  });

  log(`running ${active.length}/${accounts.length} accounts, concurrency=${cfg.concurrency}`);
  const t0 = Date.now();
  // Each account persists itself the moment it finishes (see finalizeResult) — one
  // hung/failed account can't stall or wipe the others; a kill keeps partial output.
  const results = await pool(active, cfg.concurrency, async (acct) => {
    const r = await processAccount(acct);
    finalizeResult(r, quarantine);
    return r;
  });
  fs.writeFileSync(cfg.quarantineFile, JSON.stringify(quarantine, null, 2));

  const summary = {
    ts: Date.now(),
    durationMs: Date.now() - t0,
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    empty: results.filter((r) => r.status === 'empty').length,
    auth_fail: results.filter((r) => r.status === 'auth_fail').length,
    banned: results.filter((r) => r.status === 'banned').length,
    crashed: results.filter((r) => r.status === 'crashed').length,
    threadsTotal: results.reduce((n, r) => n + r.threadCount, 0),
  };
  fs.writeFileSync(path.join(cfg.outDir, '_summary.json'), JSON.stringify(summary, null, 2));
  log(`done: ${summary.ok} ok · ${summary.empty} empty · ${summary.auth_fail} auth_fail · ${summary.banned} banned · ${summary.crashed} crashed`);

  // Non-zero exit if every account failed — lets a cron/CI flag a dead run.
  process.exit(summary.ok > 0 ? 0 : 4);
}

// Only run when invoked directly, so test_farm.mjs can import the pure helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
