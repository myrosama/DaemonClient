// Modern HEIC/HEIF → JPEG decoder. The previously-bundled heic2any (0.4.5)
// shipped an ancient libheif that can't parse modern iPhone HEICs (grid/tiled
// HEVC) — it failed with "Could not parse HEIF file". This uses libheif-js's
// self-contained wasm-bundle (libheif 1.19.x, verified to decode iPhone HEICs),
// inlined so there's no separate .wasm fetch to misconfigure under Vite.
// @ts-expect-error - wasm-bundle has no bundled types
import libheif from 'libheif-js/wasm-bundle';

/** Decode HEIC/HEIF bytes to a JPEG Blob via an offscreen canvas. */
export async function decodeHeicToBlob(input: Blob, quality = 0.85): Promise<Blob> {
  const buffer = new Uint8Array(await input.arrayBuffer());
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buffer);
  if (!images || images.length === 0) {
    throw new Error('HEIF: no images decoded');
  }
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('HEIF: no 2d context');
  const imageData = ctx.createImageData(width, height);

  // libheif fills the RGBA buffer asynchronously via the callback.
  await new Promise<void>((resolve, reject) => {
    image.display(imageData, (displayData: ImageData | null) => {
      if (!displayData) reject(new Error('HEIF: display() failed'));
      else resolve();
    });
  });

  ctx.putImageData(imageData, 0, 0);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('HEIF: toBlob failed'))), 'image/jpeg', quality),
  );
}
