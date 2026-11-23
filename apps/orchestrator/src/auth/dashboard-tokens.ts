import { createHash, randomBytes } from 'node:crypto';
import { approverNameSchema } from '@page/contracts';

/** One person's entry in DASHBOARD_TOKENS: their name and the SHA-256 of their token. */
export interface DashboardToken {
  name: string;
  /** The token's SHA-256, in lowercase hex. The token itself is never configured. */
  sha256: string;
}

/**
 * A token's SHA-256 digest. A dashboard token is 32 random bytes, so a fast hash is enough:
 * nobody can work a token back from its digest. A password would need a slow hash instead.
 */
export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** A token's SHA-256 in lowercase hex, as a DASHBOARD_TOKENS entry holds it. */
export const hashToken = (token: string): string => tokenDigest(token).toString('hex');

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Reads DASHBOARD_TOKENS: `name:sha256hex` entries, comma-separated, such as
 * `Arjun:9f86...,Nidheesh:60303...`. A name follows approverNameSchema, so it holds no colon
 * or comma. Blank entries are skipped. Throws an Error that names the entry by its position
 * and says what is wrong with it, without repeating the hash.
 */
export function parseDashboardTokens(value: string): DashboardToken[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const tokens: DashboardToken[] = [];
  const names = new Map<string, number>();
  const hashes = new Map<string, number>();
  entries.forEach((entry, i) => {
    const at = `entry ${i + 1}`;
    const parts = entry.split(':');
    if (parts.length !== 2) throw new Error(`${at} is not name:sha256`);
    const name = approverNameSchema.safeParse(parts[0]);
    if (!name.success) {
      throw new Error(`${at}: the name must be 1 to 40 letters, digits, spaces or .'_-`);
    }
    const sha256 = parts[1]!.trim().toLowerCase();
    if (!SHA256_HEX.test(sha256)) throw new Error(`${at}: the hash must be 64 hex characters`);
    // Names that differ only in case would read as one person in the record.
    const key = name.data.toLowerCase();
    const sameName = names.get(key);
    if (sameName !== undefined) throw new Error(`entries ${sameName} and ${i + 1} name one person`);
    const sameHash = hashes.get(sha256);
    if (sameHash !== undefined) throw new Error(`entries ${sameHash} and ${i + 1} hold one token`);
    names.set(key, i + 1);
    hashes.set(sha256, i + 1);
    tokens.push({ name: name.data, sha256 });
  });
  return tokens;
}

/** A new dashboard token for one person. */
export interface NewDashboardToken {
  name: string;
  /** The token to hand the person, once. Nothing keeps it. */
  token: string;
  /** What to add to DASHBOARD_TOKENS for it: `name:sha256hex`. */
  entry: string;
}

/**
 * A new token for `name`: 32 random bytes in base64url, and the DASHBOARD_TOKENS entry that
 * admits it. Throws if the name is not one a person may have (approverNameSchema).
 */
export function newDashboardToken(
  name: string,
  bytes: Buffer = randomBytes(32),
): NewDashboardToken {
  const parsed = approverNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new Error(`${JSON.stringify(name)}: a name is 1 to 40 letters, digits, spaces or .'_-`);
  }
  const token = bytes.toString('base64url');
  return { name: parsed.data, token, entry: `${parsed.data}:${hashToken(token)}` };
}
