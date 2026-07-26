// `daemonclient password` — change the sign-in password.
//
// Goes straight to D1 with the operator's own Cloudflare token, exactly like
// setup did. That means it works even when you have forgotten the current
// password (whoever holds the Cloudflare token owns the install anyway), and
// it needs no password-reset email service.

import crypto from 'node:crypto';
import { c, accent, blank, line, ok, fail, hint, spinner, ask, askSecret, confirm } from '../ui.mjs';
import { loadState, saveState, isDone } from '../state.mjs';
import * as cf from '../api/cloudflare.mjs';
import { hashPasswordNode } from '../password.mjs';

export async function runPassword() {
  const state = loadState();
  blank();

  if (!isDone(state, 'deploy')) {
    fail('Nothing deployed from this folder yet.');
    hint(`Run ${accent('daemonclient setup')} first.`);
    return;
  }

  const email = await ask('Which account?', { defaultValue: state.adminEmail || '' });

  let password;
  while (true) {
    password = await askSecret('New password (12+ characters)', {
      validate: (v) => (v.length >= 12 ? null : 'Please use at least 12 characters.'),
    });
    const again = await askSecret('Type it again');
    if (again === password) break;
    fail('Those did not match — try again.');
  }

  const s = spinner('Updating');
  try {
    const passwordHash = await hashPasswordNode(password);
    const result = await cf.queryD1(
      state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      `INSERT INTO users (id, email, passwordHash, name, isAdmin, createdAt)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(email) DO UPDATE SET passwordHash = excluded.passwordHash, updatedAt = excluded.createdAt`,
      [crypto.randomUUID(), email.toLowerCase(), passwordHash, email.split('@')[0], new Date().toISOString()],
    );
    s.succeed(`Password updated for ${c.bold(email)}`);
  } catch (e) {
    s.fail(`Could not update the password: ${e.message}`);
    return;
  }

  state.adminEmail = email.toLowerCase();
  saveState(state);
  blank();
  hint('Existing sessions stay signed in. Sign out everywhere by rotating SESSION_SECRET (daemonclient doctor explains how).');
  blank();
}
