import { randomBytes, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(rawScrypt);
export const token = () => randomBytes(32).toString('hex');
export const hashToken = (s: string) => createHash('sha256').update(s).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256 || password === 'password') throw Object.assign(new Error('Use a password between 10 and 256 characters.'), { status: 400 });
}
export function cookieValue(header: string | undefined, name: string) {
  return header?.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}
