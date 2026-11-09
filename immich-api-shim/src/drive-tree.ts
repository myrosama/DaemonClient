// Drive's folder tree rules for release W1 (docs/drive/W1.md): what is hidden
// by Trash, which moves are allowed, and which names are file-manager temp
// files. Pure functions over the rows of the `files` table.

export interface TreeRow {
  id: string;
  parentId: string;
  type?: string;
  trashedAt?: string | null;
  purgingAt?: string | null;
}

export const TRASH_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ids hidden from listings and WebDAV: trashed or marked items and everything
 * below them. Old data had no move check, so the walk up stops at a repeat
 * (a cycle with nothing trashed in it stays visible) and at a missing parent
 * (an orphan stays visible, as before).
 */
export function hiddenIds(rows: TreeRow[]): Set<string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const known = new Map<string, boolean>();
  for (const start of rows) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: TreeRow | undefined = start;
    let hidden = false;
    while (cur) {
      const memo = known.get(cur.id);
      if (memo !== undefined) { hidden = memo; break; }
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      path.push(cur.id);
      if (cur.trashedAt || cur.purgingAt) { hidden = true; break; }
      cur = cur.parentId === 'root' ? undefined : byId.get(cur.parentId);
    }
    for (const id of path) known.set(id, hidden);
  }
  return new Set([...known].filter(([, h]) => h).map(([id]) => id));
}

/**
 * Why `nodeId` may not move into `newParentId`, or null. The new parent must
 * be the top level or a visible folder that is not the node or below it.
 */
export function moveRefusal(rows: TreeRow[], nodeId: string, newParentId: string, hidden = hiddenIds(rows)): string | null {
  if (newParentId === 'root') return null;
  if (newParentId === nodeId) return 'A folder cannot go inside itself';
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parent = byId.get(newParentId);
  if (!parent || parent.type !== 'folder' || hidden.has(newParentId)) return 'The destination folder does not exist';
  const seen = new Set<string>();
  for (let cur: TreeRow | undefined = parent; cur && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
    if (cur.id === nodeId) return 'A folder cannot go inside one of its own folders';
    seen.add(cur.id);
  }
  return null;
}

// Files that Finder, GNOME, Office and LibreOffice create and delete on their
// own while saving; a WebDAV delete of one is final instead of filling Trash.
const TEMP_NAMES = [/^\._/, /^\.goutputstream-/, /^~\$/, /^\.~lock\./];
export function isTempFileName(name: string): boolean {
  return TEMP_NAMES.some((re) => re.test(name));
}

/**
 * A thumbnail reference from a client: {message_id, file_id} → the stored JSON
 * string; null clears it; undefined leaves it alone; anything else throws.
 */
export function parseThumb(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const t = raw as any;
  if (typeof t === 'object' && Number.isSafeInteger(t.message_id) && t.message_id > 0
    && typeof t.file_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(t.file_id)) {
    return JSON.stringify({ message_id: t.message_id, file_id: t.file_id });
  }
  throw new Error('thumb must be {message_id, file_id}');
}

/** Whether two stored `messages` values describe the same parts. */
export function sameMessages(stored: unknown, incoming: string | null): boolean {
  const norm = (v: unknown) => {
    if (v == null) return 'null';
    try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v); } catch { return String(v); }
  };
  return norm(stored) === norm(incoming);
}
