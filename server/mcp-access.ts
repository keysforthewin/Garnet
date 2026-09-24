import { readFile, lstat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

export async function validLocalCredential(file: string, supplied: string | undefined) {
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return false;
    const secret = (await readFile(file, 'utf8')).trim();
    return secret.length === supplied.length && timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
  } catch { return false; }
}
