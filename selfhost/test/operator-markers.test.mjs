import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOperatorMarkers, OPERATOR_PROJECT_ID } from '../src/operator-markers.mjs';

const MINE = 'AIza' + 'A'.repeat(35);
const THEIRS = 'AIza' + 'B'.repeat(35);
const me = { apiKey: MINE, projectId: 'my-own-project' };

test('a clean self-host bundle reports nothing', () => {
  assert.deepEqual(findOperatorMarkers(`const k="${MINE}";const p="my-own-project"`, me), []);
});

test('catches the operator data host', () => {
  const hits = findOperatorMarkers('fetch("https://api.daemonclient.uz/x")', { ...me, host: 'api.daemonclient.uz' });
  assert.equal(hits.length, 1);
  assert.match(hits[0], /operator host api\.daemonclient\.uz/);
});

test('catches the operator project id', () => {
  const hits = findOperatorMarkers(`authDomain:"${OPERATOR_PROJECT_ID}.firebaseapp.com"`, me);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /operator Firebase project/);
});

test('catches a Google API key that is not the user own', () => {
  const hits = findOperatorMarkers(`apiKey:"${THEIRS}"`, me);
  assert.deepEqual(hits, ['contains a Google API key that is not yours']);
});

test('the user own key is allowed through', () => {
  assert.deepEqual(findOperatorMarkers(`apiKey:"${MINE}"`, me), []);
});

test('fails CLOSED when the user key is unknown', () => {
  // No apiKey in state: we cannot distinguish, so we must not wave it through.
  const hits = findOperatorMarkers(`apiKey:"${MINE}"`, { projectId: 'p' });
  assert.deepEqual(hits, ['contains a Google API key that is not yours']);
});

test('never echoes key material into the message', () => {
  const hits = findOperatorMarkers(`apiKey:"${THEIRS}"`, me);
  const joined = hits.join(' ');
  assert.ok(!joined.includes(THEIRS), 'full key leaked into guard message');
  assert.ok(!joined.includes(THEIRS.slice(-6)), 'key fragment leaked into guard message');
});

test('reports every distinct reason at once, each only once', () => {
  const text = `${THEIRS} ${THEIRS} https://api.daemonclient.uz ${OPERATOR_PROJECT_ID}`;
  const hits = findOperatorMarkers(text, { ...me, host: 'api.daemonclient.uz' });
  assert.equal(hits.length, 3, `expected 3 distinct reasons, got ${JSON.stringify(hits)}`);
});

test('the operator building their own project is not flagged for the project id', () => {
  // Guard must not fire on projectId when that IS the configured project.
  const hits = findOperatorMarkers(OPERATOR_PROJECT_ID, { apiKey: MINE, projectId: OPERATOR_PROJECT_ID });
  assert.deepEqual(hits, []);
});

test('a foreign key after the user own key is still caught', () => {
  // The user's key first, then the operator's: the loop must not stop at the
  // first (allowed) match.
  const hits = findOperatorMarkers(`a:"${MINE}" b:"${THEIRS}"`, me);
  assert.deepEqual(hits, ['contains a Google API key that is not yours']);
});
