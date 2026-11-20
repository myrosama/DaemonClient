import { describe, it, expect, vi } from 'vitest';
import { D1Adapter, PHOTO_COLUMNS } from './d1-adapter';

// savePhoto and updatePhoto build their statements from the KEYS of the object
// they are handed. Values are bound and safe; identifiers are interpolated
// straight into the SQL string. So a caller that passed user-controlled keys
// passed user-controlled SQL — and one did: `/api/assets/finalize-client-upload`
// spread the raw request body into savePhoto, for any authenticated user.
//
// That route is deleted. This is the other half: the shape that made it
// dangerous is still here, so unknown keys are now dropped before they can
// reach the string.

function spyDb() {
  const statements: string[] = [];
  const db: any = {
    statements,
    prepare: (sql: string) => {
      statements.push(sql);
      return { bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };
    },
  };
  return db;
}

const EVIL = '`id`, x) VALUES (1) --';

describe('savePhoto cannot be made to emit attacker SQL', () => {
  it('drops a crafted key instead of interpolating it', async () => {
    const db = spyDb();
    await new D1Adapter(db).savePhoto({ id: 'p1', ownerId: 'u1', [EVIL]: 'x' } as any);
    expect(db.statements.join('\n')).not.toContain('--');
    expect(db.statements.join('\n')).not.toContain('VALUES (1)');
  });

  it('drops a DROP TABLE attempt', async () => {
    const db = spyDb();
    await new D1Adapter(db).savePhoto({ id: 'p1', 'x); DROP TABLE photos; --': 1 } as any);
    expect(db.statements.join('\n').toUpperCase()).not.toContain('DROP TABLE');
  });

  it('still writes the legitimate columns alongside a rejected one', async () => {
    const db = spyDb();
    await new D1Adapter(db).savePhoto({ id: 'p1', ownerId: 'u1', fileName: 'a.jpg', [EVIL]: 'x' } as any);
    const sql = db.statements.join('\n');
    expect(sql).toContain('ownerId');
    expect(sql).toContain('fileName');
  });

  it('writes nothing at all when every key is bogus', async () => {
    const db = spyDb();
    await new D1Adapter(db).savePhoto({ 'bad key': 1 } as any);
    expect(db.statements).toEqual([]);
  });

  it('updatePhoto has the same guard', async () => {
    const db = spyDb();
    await new D1Adapter(db).updatePhoto('p1', { [EVIL]: 'x', isFavorite: 1 } as any);
    const sql = db.statements.join('\n');
    expect(sql).not.toContain('--');
    expect(sql).toContain('isFavorite');
  });

  it('every real column is still accepted — the guard must not break writes', async () => {
    const db = spyDb();
    const row: any = { id: 'p1' };
    for (const c of PHOTO_COLUMNS) row[c] = c === 'id' ? 'p1' : 'v';
    await new D1Adapter(db).savePhoto(row);
    const sql = db.statements.join('\n');
    for (const c of PHOTO_COLUMNS) expect(sql).toContain(c);
  });
});
