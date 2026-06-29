// Scrape Messenger conversation (thread) names from the chat list.
// The selectors here are the most fragile part — FB's DOM is obfuscated and
// changes often. If this returns nothing, run with --headful, inspect a
// conversation row in DevTools, and update the selectors below.
import { setTimeout as sleep } from 'node:timers/promises';

const MESSENGER_URL = 'https://www.facebook.com/messages/t/';
const ROW_SELECTOR = '[role="grid"] [role="row"]';
const SCROLL_SETTLE_MS = 900;   // let lazy-loaded rows hydrate after each scroll
const MAX_SCROLL_ITERS = 120;   // hard ceiling so a never-settling list can't spin forever
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
    await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' });
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
      await page.evaluate(scrollChatListInPage);
    } catch {
      /* transient detach — next iteration's waitForSelector recovers */
    }
    await sleep(SCROLL_SETTLE_MS);
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

// Scroll the chat list to its bottom to pull the next lazy-loaded batch.
// The scroll container is a plain div ANCESTOR of the rows (not the grid
// itself), identified by being the nearest ancestor that actually overflows.
// Setting scrollTop here is immune to the modal overlay (unlike mouse wheel).
function scrollChatListInPage() {
  const row = document.querySelector('[role="grid"] [role="row"]');
  if (!row) return;
  let el = row;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 20) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    el = el.parentElement;
  }
}
