import { isMultipartRequest, parseMultipartRequest } from '@mjackson/multipart-parser';

// Single-pass streaming parse of an upload request. This replaces
// `await request.formData()` (which buffers the whole body AND duplicates the
// file) on the upload path. Two wins for big backup sessions:
//
//   1. Dedup-break: the Immich uploader writes its metadata fields BEFORE the
//      assetData file, so once we have deviceAssetId+deviceId we can ask the
//      caller whether this is an already-uploaded asset and, if so, return
//      WITHOUT the parser ever reading/buffering the file — the storm-retry
//      case that was pushing the free-tier worker over its memory/CPU limits.
//   2. The file is exposed as a FileLike over the parser's content chunks, so
//      we never make the second full-size copy that `part.bytes` / `formData`
//      would. Slicing copies only the requested window.

// Minimal Blob-ish surface the upload path needs (matches how it used the File
// from formData: .size / .name / .type / .slice(s,e).arrayBuffer()).
export interface FileLike {
  size: number;
  name: string;
  type: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export function makeFileLike(chunks: Uint8Array[], size: number, name: string, type: string): FileLike {
  return {
    size,
    name,
    type,
    slice(start: number, end: number) {
      const from = Math.max(0, start);
      const to = Math.min(size, end);
      const out = new Uint8Array(Math.max(0, to - from));
      if (out.length > 0) {
        let written = 0;
        let pos = 0;
        for (const ch of chunks) {
          const chStart = pos;
          const chEnd = pos + ch.length;
          pos = chEnd;
          if (chEnd <= from) continue;
          if (chStart >= to) break;
          const a = Math.max(from, chStart) - chStart;
          const b = Math.min(to, chEnd) - chStart;
          out.set(ch.subarray(a, b), written);
          written += b - a;
        }
      }
      const buf = out.buffer;
      return { arrayBuffer: async () => buf };
    },
  };
}

export type ParseResult =
  | { kind: 'dedup'; response: Response }
  | { kind: 'parsed'; fields: Map<string, string>; file: FileLike | null };

export async function parseUploadRequest(
  request: Request,
  checkEarlyDedup: (deviceAssetId: string, deviceId: string, fields: Map<string, string>) => Promise<Response | null>,
): Promise<ParseResult> {
  const fields = new Map<string, string>();
  let file: FileLike | null = null;
  let dedupChecked = false;

  // @mjackson/multipart-parser defaults maxFileSize to 2 MB and THROWS
  // MaxFileSizeExceededError on anything larger — which would reject almost every
  // photo/video. Raise it above Cloudflare's 100 MB request-body cap so it never
  // fires (the body cap is the real ceiling). Header size is tiny; leave default.
  const parserOpts = { maxFileSize: 1024 * 1024 * 1024 }; // 1 GiB (effectively unlimited)
  for await (const part of parseMultipartRequest(request, parserOpts)) {
    if (part.isFile && part.name === 'assetData') {
      file = makeFileLike(part.content, part.size, part.filename || '', part.mediaType || '');
      continue;
    }
    if (!part.name) continue;
    fields.set(part.name, part.text);

    // As soon as both ids are known (and before the file part), let the caller
    // decide whether to short-circuit. Runs at most once.
    if (!dedupChecked && !file && fields.has('deviceAssetId') && fields.has('deviceId')) {
      dedupChecked = true;
      const da = fields.get('deviceAssetId') || '';
      const di = fields.get('deviceId') || '';
      if (da && di) {
        const resp = await checkEarlyDedup(da, di, fields);
        if (resp) return { kind: 'dedup', response: resp };
      }
    }
  }

  return { kind: 'parsed', fields, file };
}

// A `formData`-shaped view over the parsed fields + file, so the existing upload
// code that calls formData.get(...) / formData.keys() works unchanged.
export interface FormDataLike {
  get(name: string): string | FileLike | null;
  keys(): IterableIterator<string>;
}

export function makeFormDataLike(fields: Map<string, string>, file: FileLike | null): FormDataLike {
  return {
    get(name: string) {
      if (name === 'assetData') return file;
      return fields.has(name) ? fields.get(name)! : null;
    },
    keys() {
      const ks = [...fields.keys()];
      if (file) ks.push('assetData');
      return ks[Symbol.iterator]();
    },
  };
}

export { isMultipartRequest };
