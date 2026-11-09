import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInStep, portalSignInUrl, portalSignOutUrl } from './sign-in.js';

const base = { signedOut: false, rejections: 0, sharedSignedIn: false, returnedFromPortal: false };

test('a shared session signs the visitor straight in', () => {
  assert.equal(signInStep({ ...base, sharedSignedIn: true }), 'done');
});

test('with no shared session, the visitor goes to the portal once', () => {
  assert.equal(signInStep(base), 'portal');
});

test('coming back from the portal still signed out shows a retry screen instead of looping', () => {
  assert.equal(signInStep({ ...base, returnedFromPortal: true }), 'failed');
});

test('right after signing out, nothing signs the person back in', () => {
  assert.equal(signInStep({ ...base, signedOut: true, sharedSignedIn: true }), 'signedOut');
});

test('one rejected token is re-exchanged silently; a second rejection stops', () => {
  assert.equal(signInStep({ ...base, rejections: 1, sharedSignedIn: true }), 'done');
  assert.equal(signInStep({ ...base, rejections: 2, sharedSignedIn: true }), 'failed');
});

test('the portal returns the visitor to the Drive dashboard, marked as a return trip', () => {
  const url = new URL(portalSignInUrl());
  assert.equal(url.origin + url.pathname, 'https://accounts.daemonclient.uz/login');
  const back = new URL(url.searchParams.get('return_url'));
  assert.equal(back.origin + back.pathname, 'https://drive.daemonclient.uz/dashboard');
  assert.equal(back.searchParams.get('sso'), '1');
});

test('signing out goes through the portal and comes back to the Drive sign-in page', () => {
  const url = new URL(portalSignOutUrl());
  assert.equal(url.origin + url.pathname, 'https://accounts.daemonclient.uz/logout');
  assert.equal(url.searchParams.get('return_url'), 'https://drive.daemonclient.uz/login');
});
