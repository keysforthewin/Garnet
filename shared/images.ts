export const maxImageBytes = 10 * 1024 * 1024;

// Raster formats browsers display, identified by their leading bytes. SVG is
// excluded because it can carry script.
const signatures: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': b => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': b => String.fromCharCode(...b.subarray(0, 6)) === 'GIF87a' || String.fromCharCode(...b.subarray(0, 6)) === 'GIF89a',
  'image/webp': b => String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
};
export const imageTypes = Object.keys(signatures);
export function imageType(bytes: Uint8Array) { return imageTypes.find(type => signatures[type](bytes)); }
