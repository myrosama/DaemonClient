import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalRedirectAllowed, portalSignInUrl, PORTAL_RETRY_MS } from './sign-in.js';

test('sends a signed-out visitor to the portal the first time', () => {
  assert.equal(portalRedirectAllowed(null, 1_000_000), true);
  assert.equal(portalRedirectAllowed('', 1_000_000), true);
});

test('does not bounce back to the portal again within a minute (no redirect loop)', () => {
  const now = 10_000_000;
  assert.equal(portalRedirectAllowed(String(now - 1), now), false);
  assert.equal(portalRedirectAllowed(String(now - PORTAL_RETRY_MS + 1), now), false);
});

test('allows the portal again once the minute has passed', () => {
  const now = 10_000_000;
  assert.equal(portalRedirectAllowed(String(now - PORTAL_RETRY_MS), now), true);
});

test('ignores a garbage or future timestamp instead of blocking sign-in forever', () => {
  assert.equal(portalRedirectAllowed('banana', 5), true);
  assert.equal(portalRedirectAllowed(String(10_000), 5), true);
});

test('the portal returns the visitor to the Drive dashboard', () => {
  const url = new URL(portalSignInUrl());
  assert.equal(url.origin, 'https://accounts.daemonclient.uz');
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('return_url'), 'https://drive.daemonclient.uz/dashboard');
});
