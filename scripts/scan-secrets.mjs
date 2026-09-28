#!/usr/bin/env node
// Refuse to commit a credential.
//
// This repository is public. Removing a secret from HEAD does not unpublish it
// — every clone and fork keeps the blob — so the only cheap fix is to never
// commit one. That is this script's whole job.
//
// No dependencies, by design: a guard that needs `npm install` to run is a
// guard that gets skipped.
//
// Usage:
//   node scripts/scan-secrets.mjs --staged     # what is about to be committed
//   node scripts/scan-secrets.mjs --all        # everything tracked
//   node scripts/scan-secrets.mjs <path...>    # specific files
//
// Allowlisting: add a line to .secret-scan-allow of the form
//   <path>:<rule>  # why this is not a real credential
// Deliberately path+rule specific, so an allowlist entry cannot silently
// forgive a different secret appearing later in the same file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  { id: 'gcp-service-account', re: /"type"\s*:\s*"service_account"/,
    what: 'a Google Cloud service-account key file' },
  { id: 'private-key-pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    what: 'a PEM private key' },
  { id: 'telegram-bot-token', re: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/,
    what: 'a Telegram bot token' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/,
    what: 'an AWS access key id' },
  { id: 'github-token', re: /\b(?:ghp|gho|ghs|ghu)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{60,}/,
    what: 'a GitHub token' },
  { id: 'slack-token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/,
    what: 'a Slack token' },
  { id: 'stripe-key', re: /\b[rs]k_live_[0-9A-Za-z]{20,}/,
    what: 'a live Stripe key' },
  { id: 'cloudflare-api-token', re: /\b(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/,
    what: 'a Cloudflare API token' },
];

// Binary and vendored paths carry no hand-written secrets and produce noise.
const SKIP = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)\.git\//,
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.terraform\.lock\.hcl)$/,
  /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp4|mov|pdf|zip|gz|so|node|wasm)$/i,
];

export function parseAllowlist(text) {
  const allow = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) allow.add(line);
  }
  return allow;
}

// The core, kept pure so it can be tested without touching git or the disk.
export function scanText(text, { file = '', allow = new Set() } = {}) {
  const found = [];
  for (const rule of RULES) {
    if (!rule.re.test(text)) continue;
    if (allow.has(`${file}:${rule.id}`)) continue;
    found.push({ file, rule: rule.id, what: rule.what });
  }
  return found;
}

function gitFiles(mode) {
  const args = mode === '--staged'
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

function main(argv) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const allowPath = path.join(root, '.secret-scan-allow');
  const allow = fs.existsSync(allowPath)
    ? parseAllowlist(fs.readFileSync(allowPath, 'utf8'))
    : new Set();

  const mode = argv.find((a) => a === '--staged' || a === '--all');
  const explicit = argv.filter((a) => !a.startsWith('--'));
  const files = explicit.length ? explicit : gitFiles(mode ?? '--staged');

  const hits = [];
  for (const f of files) {
    if (SKIP.some((re) => re.test(f))) continue;
    const abs = path.isAbsolute(f) ? f : path.join(root, f);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    hits.push(...scanText(text, { file: f, allow }));
  }

  if (!hits.length) return 0;
  // Never print the matched value: this output reaches terminals and CI logs.
  console.error('\nRefusing to commit — credential-shaped content found:\n');
  for (const h of hits) console.error(`  ${h.file}\n    looks like ${h.what}  [${h.rule}]`);
  console.error(
    '\nIf this is genuinely not a credential (a test fixture, say), add to .secret-scan-allow:\n' +
    hits.map((h) => `  ${h.file}:${h.rule}  # why`).join('\n') + '\n',
  );
  return 1;
}

// Run only when invoked directly, not when imported by the tests. Compare real
// paths: a hand-built `file://${argv[1]}` never matches once the path holds a
// space or any character a URL encodes, and then main() silently never runs —
// the hook exits 0 and a leak looks exactly like a clean commit.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
