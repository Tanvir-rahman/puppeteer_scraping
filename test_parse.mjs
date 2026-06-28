// Guards the only pure piece of scrape logic: thread-name extraction.
// Run: node test_parse.mjs   (or: pnpm test)
import assert from 'node:assert';
import { pickName } from './src/threads.js';

// clean title wins — commas in the name are PRESERVED (group names have them):
assert.equal(pickName({ title: 'Smith, Jane', ariaLabel: 'Smith, Jane, You: hi' }), 'Smith, Jane');
assert.equal(pickName({ title: 'Mom',         ariaLabel: 'Mom, ok see you'      }), 'Mom');

// fallback only when no title — lossy on commas (documented ceiling):
assert.equal(pickName({ title: '', ariaLabel: 'Work Group, Alice sent a photo' }), 'Work Group');

// nothing usable:
assert.equal(pickName({ title: '', ariaLabel: '' }), '');
assert.equal(pickName({ title: '   ', ariaLabel: '' }), '');

console.log('ok');
