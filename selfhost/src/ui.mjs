// Terminal UI primitives.
//
// No dependencies on purpose: this is the first thing a new self-hoster runs,
// and "clone the repo, run the script" should not begin with an npm install
// that can fail behind a corporate proxy or on a fresh machine. Everything
// here is ANSI escape codes and readline.

import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const isTTY = stdout.isTTY;
// Respect NO_COLOR (https://no-color.org) and dumb terminals.
const useColor = isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const code = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: code(1, 22),
  dim: code(2, 22),
  italic: code(3, 23),
  underline: code(4, 24),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  gray: code(90, 39),
  greenBg: code(42, 49),
};

// The brand accent. Green reads as "go" in a terminal and matches the product.
export const accent = c.green;

export function write(s = '') {
  stdout.write(s);
}
export function line(s = '') {
  stdout.write(s + '\n');
}
export function blank() {
  stdout.write('\n');
}

/** Visible width, ignoring ANSI escapes (so box borders line up). */
export function width(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

const termWidth = () => Math.min(stdout.columns || 80, 80);

export function rule(label = '') {
  const w = termWidth();
  if (!label) return line(c.gray('─'.repeat(w)));
  const text = ` ${label} `;
  const left = 2;
  const right = Math.max(0, w - left - width(text));
  line(c.gray('─'.repeat(left)) + c.bold(text) + c.gray('─'.repeat(right)));
}

/** A bordered panel. Used for the banner and the final summary. */
export function panel(title, lines, { color = accent } = {}) {
  const w = termWidth();
  const inner = w - 4;
  const top = `╭${'─'.repeat(w - 2)}╮`;
  const bottom = `╰${'─'.repeat(w - 2)}╯`;
  line(color(top));
  if (title) {
    const pad = inner - width(title);
    line(color('│ ') + c.bold(title) + ' '.repeat(Math.max(0, pad)) + color(' │'));
    line(color('│ ') + c.gray('─'.repeat(inner)) + color(' │'));
  }
  for (const l of lines) {
    // Wrap long lines rather than breaking the border.
    const chunks = wrap(String(l), inner);
    for (const chunk of chunks) {
      const pad = inner - width(chunk);
      line(color('│ ') + chunk + ' '.repeat(Math.max(0, pad)) + color(' │'));
    }
  }
  line(color(bottom));
}

export function wrap(text, w) {
  if (width(text) <= w) return [text];
  const words = String(text).split(' ');
  const out = [];
  let cur = '';
  for (const word of words) {
    if (cur && width(cur) + 1 + width(word) > w) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const symbols = {
  ok: c.green('✔'),
  fail: c.red('✖'),
  warn: c.yellow('!'),
  info: c.blue('i'),
  arrow: c.gray('→'),
  bullet: c.gray('•'),
};

export function ok(msg) {
  line(`  ${symbols.ok} ${msg}`);
}
export function fail(msg) {
  line(`  ${symbols.fail} ${msg}`);
}
export function warn(msg) {
  line(`  ${c.yellow('!')} ${msg}`);
}
export function info(msg) {
  line(`  ${c.gray('•')} ${msg}`);
}
export function hint(msg) {
  for (const l of wrap(msg, termWidth() - 6)) line(`    ${c.gray(l)}`);
}

/** Step heading, e.g. "Step 3 of 7 · Cloudflare". */
export function step(n, total, title) {
  blank();
  line(`${c.gray(`Step ${n}/${total}`)}  ${c.bold(title)}`);
  line(c.gray('─'.repeat(termWidth())));
}

// ── Spinner ─────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(text) {
  if (!isTTY) {
    line(`  ${text}…`);
    return {
      update: () => {},
      succeed: (m) => ok(m || text),
      fail: (m) => fail(m || text),
      stop: () => {},
    };
  }
  let i = 0;
  let current = text;
  stdout.write('\x1b[?25l'); // hide cursor
  const render = () => {
    stdout.write(`\r  ${accent(FRAMES[i++ % FRAMES.length])} ${current}${' '.repeat(10)}`);
  };
  render();
  const timer = setInterval(render, 80);
  const clear = () => {
    clearInterval(timer);
    stdout.write('\r' + ' '.repeat(termWidth()) + '\r');
    stdout.write('\x1b[?25h'); // show cursor
  };
  return {
    update: (t) => { current = t; },
    succeed: (m) => { clear(); ok(m || current); },
    fail: (m) => { clear(); fail(m || current); },
    stop: () => clear(),
  };
}

// ── Input ───────────────────────────────────────────────────────────────────

function rl() {
  return readline.createInterface({ input: stdin, output: stdout });
}

export function ask(question, { defaultValue = '', validate } = {}) {
  return new Promise((resolve) => {
    const suffix = defaultValue ? c.gray(` (${defaultValue})`) : '';
    const r = rl();
    const prompt = `  ${accent('❯')} ${question}${suffix} `;
    const run = () => {
      r.question(prompt, async (answer) => {
        const value = (answer || '').trim() || defaultValue;
        if (validate) {
          const problem = await validate(value);
          if (problem) {
            line(`    ${c.red(problem)}`);
            return run();
          }
        }
        r.close();
        resolve(value);
      });
    };
    run();
  });
}

/** Password-style input: echoes nothing. Used for tokens and passwords, so a
 *  shoulder-surfer or a screen recording never captures them. */
export function askSecret(question, { validate, allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    const run = () => {
      const r = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      const prompt = `  ${accent('❯')} ${question} `;
      // Suppress echo by overriding the output writer for this prompt.
      const originalWrite = r._writeToOutput?.bind(r);
      r._writeToOutput = function (chunk) {
        if (chunk.includes(prompt)) originalWrite?.(chunk);
        else originalWrite?.('');
      };
      r.question(prompt, async (answer) => {
        r.close();
        stdout.write('\n');
        const value = (answer || '').trim();
        if (!value && !allowEmpty) {
          line(`    ${c.red('Required.')}`);
          return run();
        }
        if (validate) {
          const problem = await validate(value);
          if (problem) {
            line(`    ${c.red(problem)}`);
            return run();
          }
        }
        resolve(value);
      });
    };
    run();
  });
}

export async function confirm(question, defaultYes = true) {
  const hintText = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(`${question} ${c.gray(`[${hintText}]`)}`, { defaultValue: defaultYes ? 'y' : 'n' });
  return /^y(es)?$/i.test(answer.trim());
}

/** Single-choice menu with arrow-key navigation, falling back to numeric entry
 *  on non-TTY (CI, piped input). */
export async function select(question, options) {
  if (!isTTY) {
    line(`  ${question}`);
    options.forEach((o, i) => line(`    ${i + 1}) ${o.label}`));
    const answer = await ask('Choose a number', { defaultValue: '1' });
    const idx = Math.max(1, Math.min(options.length, parseInt(answer, 10) || 1)) - 1;
    return options[idx].value;
  }

  let index = 0;
  const render = (first) => {
    if (!first) stdout.write(`\x1b[${options.length + 1}A`);
    stdout.write(`  ${question}\x1b[K\n`);
    options.forEach((o, i) => {
      const selected = i === index;
      const marker = selected ? accent('❯') : ' ';
      const label = selected ? c.bold(o.label) : o.label;
      const desc = o.hint ? c.gray(`  ${o.hint}`) : '';
      stdout.write(`  ${marker} ${label}${desc}\x1b[K\n`);
    });
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdout.write('\x1b[?25l');
    render(true);

    const onKey = (_str, key) => {
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + options.length) % options.length;
        render(false);
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % options.length;
        render(false);
      } else if (key.name === 'return') {
        cleanup();
        resolve(options[index].value);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        line(c.gray('\nCancelled.'));
        process.exit(130);
      }
    };
    const cleanup = () => {
      stdin.off('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\x1b[?25h');
    };
    stdin.on('keypress', onKey);
    stdin.resume();
  });
}

/** Wait for the user to finish something out-of-band (e.g. a browser step). */
export async function pause(message = 'Press Enter to continue') {
  await ask(c.gray(message), { defaultValue: ' ' });
}
