import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Guards against naming a column that does not exist.
//
// This is not hypothetical. Replacing `SELECT *` with an explicit column list
// in the sync query introduced `type` and `fileModifiedAt`, neither of which
// is a real column — `SELECT *` had been hiding that the emitting code reads
// them as optional properties that are simply always undefined. Every sync
// then failed with "D1_ERROR: no such column: type", which the app reports as
// a total sync failure. Unit tests could not catch it because the D1 stub
// answers any query, and the shape of the bug means it only appears against a
// real database.
//
// So instead of executing SQL, this reads the canonical schema and asserts
// that every column named in a query actually exists in it.

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (p: string) => fs.readFileSync(path.join(here, p), 'utf8');

/** Column names for the photos table: the CREATE TABLE in the deployment
 *  service, plus every self-healing ALTER in assets.ts. */
function photoColumns(): Set<string> {
  const deploy = read('../../deployment-service/src/index.ts');
  const create = deploy.split('CREATE TABLE photos (')[1]?.split(');')[0];
  expect(create, 'found CREATE TABLE photos').toBeTruthy();

  const cols = new Set<string>();
  for (const part of create.split(',')) {
    const m = part.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/);
    if (m) cols.add(m[1]);
  }
  for (const m of read('./assets.ts').matchAll(/ALTER TABLE photos ADD COLUMN (\w+)/g)) {
    cols.add(m[1]);
  }
  return cols;
}

/** Column names from an explicit `SELECT a, b, c FROM photos` list. */
function selectedColumns(source: string): string[][] {
  const out: string[][] = [];
  for (const m of source.matchAll(/SELECT\s+((?:(?!SELECT)[\s\S])*?)\s+FROM photos/gi)) {
    const list = m[1];
    if (list.includes('*') || /\(/.test(list)) continue; // SELECT * or aggregates
    out.push(list.split(',').map((c) => c.trim()).filter(Boolean));
  }
  return out;
}

describe('photos queries only name real columns', () => {
  const columns = photoColumns();

  it('found a plausible schema', () => {
    expect(columns.size).toBeGreaterThan(30);
    for (const required of ['id', 'ownerId', 'checksum', 'mimeType', 'isTrashed']) {
      expect(columns.has(required), `schema has ${required}`).toBe(true);
    }
  });

  it('does not contain the columns that broke sync', () => {
    // Named explicitly: if either is ever added for real, delete this test
    // rather than letting it quietly pass for the wrong reason.
    expect(columns.has('type')).toBe(false);
    expect(columns.has('fileModifiedAt')).toBe(false);
  });

  for (const file of ['sync.ts', 'timeline.ts', 'assets.ts', 'd1-adapter.ts', 'albums.ts', 'search.ts']) {
    it(`${file} selects only columns that exist`, () => {
      for (const list of selectedColumns(read(`./${file}`))) {
        for (const col of list) {
          // Skip aliases and qualified names — this check is about bare columns.
          if (/\s|\./.test(col)) continue;
          expect(columns.has(col), `${file} selects missing column "${col}"`).toBe(true);
        }
      }
    });
  }
});
