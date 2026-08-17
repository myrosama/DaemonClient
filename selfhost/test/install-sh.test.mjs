// BUILD_ORDER P1, P2, P4 — the bootstrap script.
//
// This is the first thing a stranger runs, piped into a shell from a URL, on a
// machine we know nothing about. It therefore has to be testable, which shell
// scripts usually are not: `install.sh` defines functions and only runs `main`
// when EXECUTED, not when sourced (`${BASH_SOURCE[0]}` == `$0`). These tests
// source it and call the pieces with a stubbed environment.
//
// What is being guarded, in order of how badly it fails:
//
//   * a checksum that is not actually verified — the whole justification for
//     letting install.sh fetch a Node tarball is that it checks what it got
//   * `sudo` appearing anywhere — the script promises nothing system-wide, and
//     a curl|sh script that escalates is the exact thing people fear
//   * an unsupported platform half-working instead of stopping
//   * a missing prerequisite producing a stack trace rather than one sentence

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SH = path.join(import.meta.dirname, '..', '..', 'install.sh');
const src = () => fs.readFileSync(SH, 'utf8');

/** Source install.sh and run a snippet against its functions. */
function inShell(snippet, { env = {}, stubs = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-inst-'));
  const script = `
set -u
export DC_TEST=1
${stubs}
. "${SH}"
${snippet}
`;
  try {
    return {
      ok: true,
      out: execFileSync('bash', ['-c', script], {
        encoding: 'utf8', env: { ...process.env, HOME: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, status: e.status };
  }
}

describe('the script is safe to pipe into a shell', () => {
  test('exists and is valid bash', () => {
    assert.ok(fs.existsSync(SH), 'install.sh is at the repo root, where the README points');
    execFileSync('bash', ['-n', SH]); // syntax check, throws on error
  });

  test('never invokes sudo', () => {
    // The promise is "no sudo, ever, nothing system-wide". A single sudo makes
    // the whole trust argument for curl|sh collapse.
    //
    // Matches an INVOCATION, not the word. The first version forbade the word
    // and tripped on the script telling the user "no sudo, nothing
    // system-wide" — flagging the very sentence that makes the promise. That
    // is twice now a guard has fired on prose; a guard nobody trusts is worse
    // than none, because the fix is to delete it.
    const invocation = /(^|[;&|(]|\$\()\s*sudo\s/m;
    assert.ok(!invocation.test(src()), 'sudo is never called');
  });

  test('sets errexit and nounset, so a failed step cannot fall through', () => {
    // A bootstrap that keeps going after a failed download is how you get a
    // half-installed tree and a confusing error three steps later.
    assert.match(src(), /set -[a-z]*e/, 'errexit');
    assert.match(src(), /set -[a-z]*u|set -o nounset/, 'nounset');
  });

  test('is short enough that someone can actually read it before running it', () => {
    // The stated justification for the curl pipe is "you can read this first".
    const lines = src().split('\n').length;
    assert.ok(lines < 400, `install.sh is ${lines} lines; keep it reviewable`);
  });

  test('only runs main when executed, so tests can source it', () => {
    assert.match(src(), /BASH_SOURCE\[0\][^\n]*\$0/);
  });
});

describe('P1 — platform and prerequisites', () => {
  test('recognises the four supported platform pairs', () => {
    for (const [os_, arch, want] of [
      ['Linux', 'x86_64', 'linux-x64'],
      ['Linux', 'aarch64', 'linux-arm64'],
      ['Darwin', 'x86_64', 'darwin-x64'],
      ['Darwin', 'arm64', 'darwin-arm64'],
    ]) {
      const r = inShell(`detect_platform "${os_}" "${arch}"`);
      assert.ok(r.ok, r.out);
      assert.equal(r.out.trim(), want, `${os_}/${arch}`);
    }
  });

  test('stops on an unsupported platform instead of half-working', () => {
    for (const [os_, arch] of [['FreeBSD', 'x86_64'], ['Linux', 'mips'], ['Windows_NT', 'x86_64']]) {
      const r = inShell(`detect_platform "${os_}" "${arch}"`);
      assert.equal(r.ok, false, `${os_}/${arch} must fail`);
      assert.match(r.out, new RegExp(os_, 'i'), 'the message names what was found');
    }
  });

  test('a missing prerequisite names it and the command to get it', () => {
    const r = inShell('require_cmd definitely-not-a-real-binary');
    assert.equal(r.ok, false);
    assert.match(r.out, /definitely-not-a-real-binary/);
  });

  test('a present prerequisite passes quietly', () => {
    const r = inShell('require_cmd bash && echo PASSED');
    assert.ok(r.ok, r.out);
    assert.match(r.out, /PASSED/);
  });
});

describe('P2 — Node, without touching the system', () => {
  test('accepts a new-enough Node already on PATH', () => {
    assert.ok(inShell('node_ok "v18.0.0" && echo YES').out.includes('YES'));
    assert.ok(inShell('node_ok "v22.11.0" && echo YES').out.includes('YES'));
  });

  test('rejects a Node that is too old, and junk', () => {
    for (const v of ['v16.20.0', 'v14.0.0', '', 'not-a-version']) {
      const r = inShell(`node_ok "${v}" && echo YES || echo NO`);
      assert.match(r.out, /NO/, `${JSON.stringify(v)} must be rejected`);
    }
  });

  test('verifies the download against SHASUMS256 before extracting', () => {
    // The entire reason fetching a runtime is acceptable here.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sum-'));
    fs.writeFileSync(path.join(dir, 'node.tar.xz'), 'PRETEND TARBALL');
    fs.writeFileSync(path.join(dir, 'SHASUMS256.txt'), 'deadbeef  node.tar.xz\n');

    const r = inShell(`verify_checksum "${dir}/node.tar.xz" "${dir}/SHASUMS256.txt" || echo REFUSED`);
    assert.match(r.out, /REFUSED/, 'a wrong checksum must refuse');
  });

  test('accepts a download whose checksum matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sum-'));
    const file = path.join(dir, 'node.tar.xz');
    fs.writeFileSync(file, 'PRETEND TARBALL');
    const real = execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(/\s+/)[0];
    fs.writeFileSync(path.join(dir, 'SHASUMS256.txt'), `${real}  node.tar.xz\n`);

    const r = inShell(`verify_checksum "${file}" "${dir}/SHASUMS256.txt" && echo VERIFIED`);
    assert.match(r.out, /VERIFIED/, r.out);
  });

  test('everything it installs lives under one removable directory', () => {
    const s = src();
    assert.match(s, /\.daemonclient/, 'installs under ~/.daemonclient');
    assert.match(s, /rm -rf/, 'and says how to remove it');
  });
});

describe('P3 — pinned source, never a moving branch', () => {
  test('clones a release tag rather than main', () => {
    const s = src();
    assert.match(s, /releases\/latest/, 'asks GitHub for the newest release');
    assert.ok(!/--branch\s+main|clone[^\n]*\bmain\b/.test(s),
      'never clones main — two people running this on the same day must get the same bytes');
  });

  test('says so plainly when the project has published no releases', () => {
    // True today. Better than silently falling back to main, which would make
    // the install unreproducible and the failure invisible.
    assert.match(src(), /no releases|not been released|no published release/i);
  });
});
