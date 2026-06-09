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
  const data: any = await exifr.parse(bytes, {
    tiff: true,
    ifd0: true,
    exif: true,
    gps: true,
    translateValues: true,
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
