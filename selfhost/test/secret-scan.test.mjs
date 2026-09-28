import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, parseAllowlist, RULES } from '../../scripts/scan-secrets.mjs';

// Shapes only — none of these is a real credential.
const SA_JSON = '{"type": "service_account", "project_id": "x"}';
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';
const TG = '1234567890:AA' + 'x'.repeat(33);
const AWS = 'AKIA' + 'A'.repeat(16);

test('catches a service-account key file', () => {
  assert.deepEqual(scanText(SA_JSON).map((h) => h.rule), ['gcp-service-account']);
});

test('catches a PEM private key', () => {
  assert.deepEqual(scanText(PEM).map((h) => h.rule), ['private-key-pem']);
});

test('catches a Telegram bot token', () => {
  assert.deepEqual(scanText(TG).map((h) => h.rule), ['telegram-bot-token']);
});

test('catches an AWS access key id', () => {
  assert.deepEqual(scanText(AWS).map((h) => h.rule), ['aws-access-key']);
});

test('ordinary source is not flagged', () => {
  assert.deepEqual(scanText('export const x = 1; // AIza is mentioned but no key'), []);
});

test('a Firebase web key is NOT flagged — it is public by design', () => {
  // Flagging it would train everyone to ignore this scanner.
  assert.deepEqual(scanText('apiKey: "AIza' + 'A'.repeat(35) + '"'), []);
});

test('allowlist forgives one path+rule pair only', () => {
  const allow = parseAllowlist('a/b.ts:telegram-bot-token  # fixture');
  assert.deepEqual(scanText(TG, { file: 'a/b.ts', allow }), []);
  // same rule, different file: still flagged
  assert.equal(scanText(TG, { file: 'other.ts', allow }).length, 1);
  // same file, different rule: still flagged
  assert.equal(scanText(PEM, { file: 'a/b.ts', allow }).length, 1);
});

test('reports every distinct rule a file trips', () => {
  const hits = scanText(`${SA_JSON}\n${PEM}\n${TG}`);
  assert.deepEqual(hits.map((h) => h.rule).sort(),
    ['gcp-service-account', 'private-key-pem', 'telegram-bot-token']);
});

test('no rule regex is global — a stateful lastIndex would skip findings', () => {
  // A /g regex with .test() advances lastIndex and alternates true/false.
  for (const r of RULES) {
    assert.ok(!r.re.global, `rule ${r.id} must not use the g flag`);
  }
  // prove it directly: scanning the same text twice gives the same answer
  assert.deepEqual(scanText(TG), scanText(TG));
});

// The CLI entry point, run as a real subprocess. The hook depends on main()
// actually running; a guard that silently skips it exits 0 and looks clean.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/scan-secrets.mjs', import.meta.url));

function runCli(scriptPath, target) {
  try {
    execFileSync(process.execPath, [scriptPath, target], { stdio: 'pipe', cwd: path.dirname(SCRIPT) });
    return 0;
  } catch (e) { return e.status; }
}

test('CLI refuses a credential when run from a path containing a space', () => {
  // A space URL-encodes to %20 in import.meta.url but not in argv[1]; a naive
  // equality check between them never matches and main() never runs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan with space '));
  try {
    const copy = path.join(dir, 'scan-secrets.mjs');
    fs.copyFileSync(SCRIPT, copy);
    const leak = path.join(dir, 'leak.json');
    fs.writeFileSync(leak, SA_JSON);
    assert.equal(runCli(copy, leak), 1, 'main() did not run — the hook would pass everything');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI exits 0 on a clean file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-clean-'));
  try {
    const ok = path.join(dir, 'ok.txt');
    fs.writeFileSync(ok, 'nothing to see here');
    assert.equal(runCli(SCRIPT, ok), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
