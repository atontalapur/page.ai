import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The AES-256 key SECRETS_KEY names: its SHA-256, so any long random string works. */
const keyOf = (secret: string) => createHash('sha256').update(secret).digest();

/** AES-256-GCM: base64 of iv, auth tag and ciphertext. */
export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Reverses encrypt. Throws when the key is wrong or the ciphertext was changed. */
export function decrypt(sealed: string, secret: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
