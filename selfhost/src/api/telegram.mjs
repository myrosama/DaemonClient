// Telegram Bot API calls used during setup.
//
// Everything here runs against the user's OWN bot token, from their own
// machine. Nothing is proxied through us — the setup process never sees a
// credential it does not need, and never sends one anywhere except to the
// service it belongs to.

const API = 'https://api.telegram.org';

async function call(token, method, params) {
  const url = `${API}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'unreadable response' }));
  return data;
}

/** Confirm the token is real and return the bot's identity. */
export async function getMe(token) {
  const data = await call(token, 'getMe');
  if (!data.ok) throw new Error(data.description || 'Telegram rejected this token');
  return data.result;
}

/** Confirm the bot can see the channel and, crucially, POST to it.
 *
 *  Reading chat metadata is not enough: a bot can be a member of a channel and
 *  still be unable to send. The only honest check is to actually send a message
 *  and delete it, which is what the storage layer does on every upload.
 */
export async function verifyChannelAccess(token, chatId) {
  const chat = await call(token, 'getChat', { chat_id: chatId });
  if (!chat.ok) {
    throw new Error(
      chat.description?.includes('chat not found')
        ? 'Channel not found. Check the id, and make sure the bot has been added to the channel.'
        : chat.description || 'Could not read the channel',
    );
  }

  const probe = await call(token, 'sendMessage', {
    chat_id: chatId,
    text: 'DaemonClient setup check — this message deletes itself.',
    disable_notification: true,
  });
  if (!probe.ok) {
    throw new Error(
      probe.description?.includes('not enough rights')
        ? 'The bot is in the channel but cannot post. Give it admin rights (post/edit/delete messages).'
        : probe.description || 'The bot could not post to this channel',
    );
  }

  // Best-effort cleanup; a leftover probe message is harmless but untidy.
  await call(token, 'deleteMessage', { chat_id: chatId, message_id: probe.result.message_id }).catch(() => {});

  return {
    title: chat.result.title || String(chatId),
    type: chat.result.type,
    canPost: true,
  };
}

/** Remove any webhook so the worker's getUpdates-style calls are not blocked. */
export async function clearWebhook(token) {
  return call(token, 'deleteWebhook', { drop_pending_updates: false });
}
