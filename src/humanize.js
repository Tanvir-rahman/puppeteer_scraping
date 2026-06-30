// Small human-behavior helpers: jittered timing so actions don't fire on a fixed
// metronome (the single most obvious bot tell after fingerprint). Kept tiny and
// pure so it's testable without a browser. NOT a full behavioral-emulation layer —
// ponytail: covers timing + step-scroll, the cheap high-value bits. Cursor-path /
// dwell-model emulation is a separate effort, add when FB actually flags timing.
import { setTimeout as sleep } from 'node:timers/promises';

// Inclusive-ish random int in [min, max].
export function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Sleep a random duration in [min, max] ms. Replaces fixed sleeps in hot paths.
export function humanSleep(min, max) {
  return sleep(rand(min, max));
}

// A scroll step as a fraction of the viewport, jittered — humans don't jump the
// whole list to the bottom in one frame. Returns a ratio in [0.6, 0.95].
export function scrollStepRatio() {
  return 0.6 + Math.random() * 0.35;
}
