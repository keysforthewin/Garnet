// Native base64 where the browser has it; otherwise convert in chunks rather than a byte at a time.
export function b64(bytes: Uint8Array): string {
  if ('toBase64' in bytes) return (bytes as any).toBase64();
  let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text);
}
export function unb64(text: string): Uint8Array {
  if ('fromBase64' in Uint8Array) return (Uint8Array as any).fromBase64(text);
  const binary = atob(text); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return bytes;
}
