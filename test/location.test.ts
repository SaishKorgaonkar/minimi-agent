import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocation } from '../src/location.js';

test('timezone wins over a default language', () => {
  assert.equal(resolveLocation('en-US', 'Asia/Kolkata')?.name, 'India');
  assert.equal(resolveLocation('en-US', 'Asia/Calcutta')?.code, 'IN');
});

test('language region is the fallback; unknown stays unknown', () => {
  assert.equal(resolveLocation('en-GB', 'UTC')?.name, 'United Kingdom');
  assert.equal(resolveLocation('hi', undefined)?.code, 'IN'); // "hi" maximises to hi-Deva-IN
  assert.equal(resolveLocation(undefined, 'UTC'), null);
  assert.equal(resolveLocation('not a locale!', undefined), null);
});

test('USER_COUNTRY overrides the browser', () => {
  process.env.USER_COUNTRY = 'de';
  try {
    assert.equal(resolveLocation('en-US', 'Asia/Kolkata')?.name, 'Germany');
  } finally {
    delete process.env.USER_COUNTRY;
  }
});
