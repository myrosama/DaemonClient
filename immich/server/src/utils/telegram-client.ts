/**
 * Telegram Bot API client for DaemonClient storage backend.
 *
 * Handles upload/download of encrypted file chunks to a Telegram channel,
 * with built-in retry logic and rate-limit handling.
 */

import { Readable } from 'node:stream';

const MAX_RETRIES = 5;
const CHUNK_SIZE = 19 * 1024 * 1024; // 19 MB — Telegram's document limit is 20 MB

export interface TelegramChunkInfo {
  message_id: number;
  file_id: string;
}

export interface TelegramConfig {
  botToken: string;
  channelId: string;
}

function getTelegramConfig(): TelegramConfig {
  const botToken = process.env.DAEMON_BOT_TOKEN;
  const channelId = process.env.DAEMON_CHANNEL_ID;

  if (!botToken || !channelId) {
    throw new Error(
      'DAEMON_BOT_TOKEN and DAEMON_CHANNEL_ID environment variables must be set for DaemonClient storage.',
    );
  }

  return { botToken, channelId };
}

/**
 * Upload a single chunk (buffer) to a Telegram channel as a document.
 * Returns the message_id and file_id for later retrieval.
 */
export async function uploadChunk(
  chunkData: Buffer,
  filename: string,
  config?: TelegramConfig,
): Promise<TelegramChunkInfo> {
  const { botToken, channelId } = config ?? getTelegramConfig();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const formData = new FormData();
      formData.append('chat_id', channelId);
      formData.append('document', new Blob([new Uint8Array(chunkData)]), filename);

      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: formData,
      });

      if (res.status === 429) {
        const body = (await res.json()) as any;
        const retryAfter = body?.parameters?.retry_after ?? 5;
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Telegram API error ${res.status}: ${text}`);
      }

      const body = (await res.json()) as any;
      const result = body.result;

      return {
        message_id: result.message_id,
        file_id: result.document.file_id,
      };
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) {
        throw error;
      }
      await sleep(Math.pow(2, attempt) * 1000); // exponential backoff
    }
  }

  throw new Error('uploadChunk: max retries exhausted');
}

/**
 * Download a file chunk from Telegram by its file_id.
 * Returns the raw Buffer of the file.
 */
export async function downloadChunk(fileId: string, config?: TelegramConfig): Promise<Buffer> {
  const { botToken } = config ?? getTelegramConfig();

  // Step 1: Get the file path from Telegram
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) {
    throw new Error(`Telegram getFile error: ${await infoRes.text()}`);
  }

  const infoBody = (await infoRes.json()) as any;
  const filePath = infoBody.result.file_path;

  // Step 2: Download the actual file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`Telegram file download error: ${fileRes.status}`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Download a file chunk from Telegram and return it as a Readable stream.
 */
export async function downloadChunkAsStream(fileId: string, config?: TelegramConfig): Promise<Readable> {
  const buffer = await downloadChunk(fileId, config);
  return Readable.from(buffer);
}

/**
 * Delete a message (chunk) from the Telegram channel.
 * Best-effort — does not throw on failure.
 */
export async function deleteMessage(messageId: number, config?: TelegramConfig): Promise<boolean> {
  const { botToken, channelId } = config ?? getTelegramConfig();

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, message_id: messageId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Split a buffer into chunk-sized pieces and upload each to Telegram.
 * Returns an ordered array of TelegramChunkInfo.
 */
export async function uploadFile(
  data: Buffer,
  baseFilename: string,
  config?: TelegramConfig,
): Promise<TelegramChunkInfo[]> {
  const totalParts = Math.ceil(data.length / CHUNK_SIZE);
  const chunks: TelegramChunkInfo[] = [];

  for (let i = 0; i < totalParts; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, data.length);
    const chunkData = data.subarray(start, end);
    const partName = totalParts === 1 ? baseFilename : `${baseFilename}.part${String(i + 1).padStart(3, '0')}`;

    const info = await uploadChunk(chunkData, partName, config);
    chunks.push(info);
  }

  return chunks;
}

/**
 * Download all chunks of a file from Telegram and concatenate them.
 * @param fileIds - Ordered array of Telegram file_ids
 */
export async function downloadFile(fileIds: string[], config?: TelegramConfig): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for (const fileId of fileIds) {
    const chunk = await downloadChunk(fileId, config);
    buffers.push(chunk);
  }
  return Buffer.concat(buffers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { CHUNK_SIZE, getTelegramConfig };
