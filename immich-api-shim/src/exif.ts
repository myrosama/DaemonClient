import exifr from 'exifr';

export interface PhotoExif {
  make?: string;
  model?: string;
  lensModel?: string;
  fNumber?: number;
  focalLength?: number;
  iso?: number;
  exposureTime?: string;
  orientation?: number;
  dateTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
}

// Format an EXIF exposure time (seconds, e.g. 0.004) the way cameras/Immich show
// it: "1/250" for sub-second, "2s" otherwise.
function formatExposure(v: unknown): string | undefined {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!isFinite(n) || n <= 0) return undefined;
  return n < 1 ? `1/${Math.round(1 / n)}` : `${n}s`;
}

function toIso(v: unknown): string | undefined {
  try {
    if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.toISOString();
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  } catch {
    return undefined;
  }
}

// Extract EXIF from the first chunk of an uploaded image (JPEG **or** HEIC).
// exifr reads only the metadata segments — it never decodes pixels, so this stays
// well within the Worker CPU budget. MUST be called inside a try/catch by the
// caller: a parse failure must never break an upload.
export async function extractExif(bytes: Uint8Array): Promise<PhotoExif> {
  const out: PhotoExif = {};
  // tiff/ifd0/exif → camera + lens + exposure tags; gps → decimal latitude/longitude.
  // translateValues MUST stay false: with it on, Orientation comes back as a
  // human string ("Horizontal (normal)") instead of the numeric 1-8 code that
  // Immich's rotation logic expects. reviveValues turns EXIF dates into Date.
  const data: any = await exifr.parse(bytes, {
    tiff: true,
    exif: true,
    gps: true,
    translateValues: false,
    reviveValues: true,
  });
  if (!data) return out;

  if (data.Make) out.make = String(data.Make).trim();
  if (data.Model) out.model = String(data.Model).trim();
  if (data.LensModel) out.lensModel = String(data.LensModel).trim();
  if (typeof data.FNumber === 'number') out.fNumber = data.FNumber;
  if (typeof data.FocalLength === 'number') out.focalLength = data.FocalLength;
  if (typeof data.ISO === 'number') out.iso = data.ISO;
  else if (Array.isArray(data.ISO) && typeof data.ISO[0] === 'number') out.iso = data.ISO[0];
  const exp = formatExposure(data.ExposureTime);
  if (exp) out.exposureTime = exp;
  if (typeof data.Orientation === 'number') out.orientation = data.Orientation;
  const dto = toIso(data.DateTimeOriginal);
  if (dto) out.dateTimeOriginal = dto;
  // exifr computes signed decimal coordinates when { gps: true }.
  if (typeof data.latitude === 'number' && isFinite(data.latitude)) out.latitude = data.latitude;
  if (typeof data.longitude === 'number' && isFinite(data.longitude)) out.longitude = data.longitude;

  return out;
}

/**
 * The `exif` field a client upload sends (SPEC D23: the phone reads EXIF
 * itself), checked field by field: unknown keys and bad values are dropped,
 * and anything that isn't a JSON object yields null. Never throws.
 */
export function clientExif(raw: unknown): PhotoExif | null {
  let v: any;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const str = (x: unknown, max: number) => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : undefined);
  const num = (x: unknown, ok: (n: number) => boolean) => (typeof x === 'number' && Number.isFinite(x) && ok(x) ? x : undefined);
  const out: PhotoExif = {
    make: str(v.make, 200),
    model: str(v.model, 200),
    lensModel: str(v.lensModel, 200),
    fNumber: num(v.fNumber, (n) => n > 0 && n < 1000),
    focalLength: num(v.focalLength, (n) => n >= 0 && n < 100000),
    iso: num(v.iso, (n) => n > 0 && n < 10_000_000),
    exposureTime: str(v.exposureTime, 40),
    orientation: num(v.orientation, (n) => Number.isInteger(n) && n >= 1 && n <= 8),
    dateTimeOriginal: str(v.dateTimeOriginal, 40),
  };
  const lat = num(v.latitude, (n) => n >= -90 && n <= 90);
  const lon = num(v.longitude, (n) => n >= -180 && n <= 180);
  if (lat !== undefined && lon !== undefined) { out.latitude = lat; out.longitude = lon; }
  for (const k of Object.keys(out) as (keyof PhotoExif)[]) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}
