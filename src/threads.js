// Scrape Messenger conversation (thread) names from the chat list.
// The selectors here are the most fragile part — FB's DOM is obfuscated and
// changes often. If this returns nothing, run with --headful, inspect a
// conversation row in DevTools, and update the selectors below.
import { setTimeout as sleep } from 'node:timers/promises';
import { humanSleep, scrollStepRatio } from './humanize.js';

const MESSENGER_URL = 'https://www.facebook.com/messages/t/';
const ROW_SELECTOR = '[role="grid"] [role="row"]';
const SETTLE_MIN_MS = 700;      // jittered settle window after each scroll (humanized) —
const SETTLE_MAX_MS = 1500;     //   fixed cadence is an obvious bot tell
const MAX_SCROLL_ITERS = 200;   // hard ceiling; raised because step-scroll takes more iters
const STABLE_ROUNDS = 5;        // stop after N scrolls add no new names

// Pure, unit-tested. Clean title wins (group names legitimately contain commas,
// so we never split when a title is available); aria-label is the lossy fallback.
export function pickName({ title, ariaLabel }) {
  const t = title && title.trim();
  if (t) return t;
  if (ariaLabel) return ariaLabel.split(',')[0].trim();
  return '';
}

// Returns an array of unique thread names. Caller decides what an empty result
// means (see cli.js: empty => exit 3).
export async function collectThreadNames(page) {
  // ensureLoggedIn already navigated us into Messenger (often into a /t/<thread>
  // view — the chat list lives in the left pane on EVERY page). Re-navigating
  // here detaches the frame mid-scrape ("Attempted to use detached Frame"), so
  // only goto if we're somehow not on messenger.
  if (!page.url().includes('/messages')) {
    // FB client-redirects aggressively and cancels the pending navigation, surfacing
    // as net::ERR_ABORTED even though the page still ends up on Messenger. Swallow it
    // and let waitForSelector below be the real "are we there yet" check.
    await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForSelector(ROW_SELECTOR, { timeout: 30000 });
  await sleep(2500); // let the first batch hydrate

  // NOTE: we scroll via JS scrollTop, NOT mouse wheel. Messenger throws an
  // E2EE "restore your chats" modal on a fresh device whose dimming overlay
  // eats pointer/wheel events — but scrollTop on the list container works under
  // it, so we don't need to dismiss the modal at all. The list virtualizes, so
  // names are accumulated into a Set across iterations (old rows unload).
  const seen = new Set();
  let stable = 0;
  for (let i = 0; i < MAX_SCROLL_ITERS && stable < STABLE_ROUNDS; i++) {
    let rows;
    try {
      rows = await page.evaluate(extractRowsInPage);
    } catch {
      // FB sometimes re-navigates (session refresh) and detaches the frame.
      // Wait for the list to return and retry instead of crashing the run.
      await page.waitForSelector(ROW_SELECTOR, { timeout: 15000 }).catch(() => {});
      await sleep(1000);
      continue;
    }
    const before = seen.size;
    for (const raw of rows) {
      const name = pickName(raw);
      if (name) seen.add(name);
    }
    stable = seen.size === before ? stable + 1 : 0;
    try {
      await page.evaluate(scrollChatListInPage, scrollStepRatio());
    } catch {
      /* transient detach — next iteration's waitForSelector recovers */
    }
    await humanSleep(SETTLE_MIN_MS, SETTLE_MAX_MS); // jittered, not a fixed metronome
  }
  return [...seen];
}

// Runs in the browser. Must be self-contained (no closures over Node vars).
// Returns raw {title, ariaLabel} pairs; name extraction happens in Node via
// pickName so the logic has a single, testable home.
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
  return out;
}

// Scroll the chat list DOWN BY A STEP to pull the next lazy-loaded batch. Humans
// don't teleport to the bottom — they scroll a screenful at a time, so we advance
// by `stepRatio` of the visible height instead of jumping to scrollHeight. The
// scroll container is a plain div ANCESTOR of the rows (not the grid itself),
// identified by being the nearest ancestor that actually overflows. Setting
// scrollTop here is immune to the modal overlay (unlike mouse wheel).
function scrollChatListInPage(stepRatio) {
  const row = document.querySelector('[role="grid"] [role="row"]');
  if (!row) return;
  let el = row;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 20) {
      const step = Math.max(120, el.clientHeight * (stepRatio || 0.8));
      el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
      return;
    }
    el = el.parentElement;
  }
}
