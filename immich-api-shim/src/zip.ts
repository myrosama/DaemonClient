// Minimal streaming ZIP writer — STORE only (no compression).
//
// Why STORE: photos/videos are already compressed, DEFLATE would burn Worker
// CPU for ~0% gain. Why streaming: archives can be GBs; we must never hold
// more than one Telegram chunk in memory. Entries use the bit-3 "data
// descriptor" layout so bytes can be emitted BEFORE the CRC/size are known,
// and bit 11 (UTF-8 names). Every mainstream unzipper (Windows Explorer,
// macOS, 7zip, Android) handles this layout.
//
// No ZIP64: callers must keep a single archive under 4 GiB and 65535 entries —
// /api/download/info splits selections into multiple archives accordingly.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

interface Entry {
  nameBytes: Uint8Array;
  offset: number;
  crc: number;
  size: number;
  dosTime: number;
  dosDate: number;
}

function dosDateTime(d: Date): { dosTime: number; dosDate: number } {
  return {
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    dosDate: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u16(v: number): [number, number] { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v: number): [number, number, number, number] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

export class StoreZipWriter {
  private offset = 0;
  private entries: Entry[] = [];
  private current: Entry | null = null;
  private crcState = 0xffffffff;

  // emit must apply backpressure (e.g. TransformStream writer.write) so a slow
  // client never makes the Worker buffer the whole archive.
  constructor(private emit: (b: Uint8Array) => Promise<void>) {}

  private async write(b: Uint8Array): Promise<void> {
    await this.emit(b);
    this.offset += b.length;
  }

  async beginFile(name: string, mtime = new Date()): Promise<void> {
    if (this.current) throw new Error('beginFile called before endFile');
    const nameBytes = new TextEncoder().encode(name);
    const { dosTime, dosDate } = dosDateTime(mtime);
    const entry: Entry = { nameBytes, offset: this.offset, crc: 0, size: 0, dosTime, dosDate };
    // Local file header — sizes/CRC zero, real values follow in the data descriptor.
    await this.write(new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,       // local file header signature
      ...u16(20),                    // version needed: 2.0
      ...u16(0x0808),                // flags: data descriptor + UTF-8 names
      ...u16(0),                     // method: STORE
      ...u16(dosTime), ...u16(dosDate),
      ...u32(0), ...u32(0), ...u32(0), // crc, csize, usize (deferred)
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]));
    this.current = entry;
    this.crcState = 0xffffffff;
  }

  async writeData(chunk: Uint8Array): Promise<void> {
    if (!this.current) throw new Error('writeData without beginFile');
    let c = this.crcState;
    for (let i = 0; i < chunk.length; i++) {
      c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
    }
    this.crcState = c;
    this.current.size += chunk.length;
    await this.write(chunk);
  }

  async endFile(): Promise<void> {
    const e = this.current;
    if (!e) throw new Error('endFile without beginFile');
    e.crc = (this.crcState ^ 0xffffffff) >>> 0;
    // Data descriptor (with optional-but-universal signature)
    await this.write(new Uint8Array([
      0x50, 0x4b, 0x07, 0x08,
      ...u32(e.crc), ...u32(e.size), ...u32(e.size),
    ]));
    this.entries.push(e);
    this.current = null;
  }

  async finish(): Promise<void> {
    if (this.current) throw new Error('finish with an open file');
    const cdStart = this.offset;
    for (const e of this.entries) {
      await this.write(new Uint8Array([
        0x50, 0x4b, 0x01, 0x02,      // central directory header signature
        ...u16(20), ...u16(20),       // made by / needed
        ...u16(0x0808), ...u16(0),    // flags, method STORE
        ...u16(e.dosTime), ...u16(e.dosDate),
        ...u32(e.crc), ...u32(e.size), ...u32(e.size),
        ...u16(e.nameBytes.length), ...u16(0), ...u16(0), // name/extra/comment len
        ...u16(0), ...u16(0),         // disk start, internal attrs
        ...u32(0),                    // external attrs
        ...u32(e.offset),
        ...e.nameBytes,
      ]));
    }
    const cdSize = this.offset - cdStart;
    await this.write(new Uint8Array([
      0x50, 0x4b, 0x05, 0x06,        // end of central directory
      ...u16(0), ...u16(0),
      ...u16(this.entries.length), ...u16(this.entries.length),
      ...u32(cdSize), ...u32(cdStart),
      ...u16(0),
    ]));
  }
}
