// Unit tests for the farm orchestrator's pure decision logic — no Chrome, no
// network, no subprocesses. Runs in ms. `node test_farm.mjs` (or `pnpm test`).
import assert from 'node:assert';
import { classifyExit, shouldRetry, backoffMs, isHardBan } from './src/farm.js';

// classifyExit maps CLI exit codes to statuses.
assert.equal(classifyExit(0), 'ok');
assert.equal(classifyExit(1), 'bad_args');
assert.equal(classifyExit(2), 'auth_fail');
assert.equal(classifyExit(3), 'empty');
assert.equal(classifyExit(137), 'crashed'); // SIGKILL exit
assert.equal(classifyExit(null), 'crashed');

// shouldRetry: only transient classes, and only under the cap.
assert.equal(shouldRetry('auth_fail', 1, 2), true);
assert.equal(shouldRetry('auth_fail', 2, 2), false); // hit cap
assert.equal(shouldRetry('crashed', 1, 2), true);
assert.equal(shouldRetry('bad_args', 1, 2), false);  // config error, never retry
assert.equal(shouldRetry('empty', 1, 2), false);     // terminal
assert.equal(shouldRetry('ok', 1, 2), false);

// backoffMs: grows with attempt, stays within [base, base+jitter], capped.
const b1 = backoffMs(1);
const b2 = backoffMs(2);
assert.ok(b1 >= 2000 && b1 <= 3000, `b1=${b1}`);  // 2^1*1000 + [0,1000]
assert.ok(b2 >= 4000 && b2 <= 5000, `b2=${b2}`);  // 2^2*1000 + [0,1000]
assert.ok(backoffMs(20) <= 61000, 'cap holds');   // capped at 60s + jitter

// isHardBan: matches FB's account-dead phrasing, ignores normal chatter.
assert.equal(isHardBan('Your account has been disabled'), true);
assert.equal(isHardBan("we've suspended your account"), true);
assert.equal(isHardBan('[auth] cookies stale — need to log in again'), false);
assert.equal(isHardBan(''), false);
assert.equal(isHardBan(undefined), false);

console.log('ok');
