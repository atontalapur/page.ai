// Syncs the team's shared secrets between the encrypted, committed `.env.shared` and each
// dev's own `.env`. Run from the repo root.
//
//   pnpm env:pull            decrypt .env.shared and write its values into .env
//   pnpm env:share KEY...    copy KEY from your .env into .env.shared, encrypted
//
// Pulling needs the private key DOTENV_PRIVATE_KEY_SHARED, from the environment or from
// .env.keys (gitignored). Get it from a teammate once, out of band. Sharing needs only the
// public key, which is in .env.shared. Values never print.
//
// Only what's in .env.shared is overwritten on pull; every other line in .env stays. A
// missing .env is created from .env.example first.
//
// .env.shared is public and anyone can encrypt into it, so pull treats it as untrusted: only
// the keys in SHARED_KEYS, every value encrypted, and each decrypted value written as a
// literal. dotenvx.parse would run `$(...)` in a decrypted value, so it never reads this file.
// Files are parsed with node:util parseEnv, which reads them the way `node --env-file` does.
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseEnv } from 'node:util';

const require = createRequire(import.meta.url);
const dotenvx = require('@dotenvx/dotenvx');
const { decrypt } = require('@dotenvx/primitives');

// Adding a shared secret means adding it here, so the change shows up in review.
const SHARED_KEYS = ['NODE_SHARED_SECRET', 'POSTHOG_WEBHOOK_SECRET', 'OPENROUTER_API_KEY'];
const ENCRYPTED = 'encrypted:';
const SHARED = '.env.shared';
const KEYS = '.env.keys';
const LOCAL = '.env';
const EXAMPLE = '.env.example';
const KEY_NAME = 'DOTENV_PRIVATE_KEY_SHARED';
const PUBLIC_KEY = 'DOTENV_PUBLIC_KEY_SHARED';
const HEADER = '# Shared secrets, from .env.shared (pnpm env:pull)';
// Keep everything on disk: no remote key custody, OS keychain, 1Password or Bitwarden.
const LOCAL_ONLY = { noArmor: true, noNative: true, no1Password: true, noBitwarden: true };

function fail(message) {
  console.error(`env-sync: ${message}`);
  process.exit(1);
}

function parseFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}

function privateKey() {
  if (process.env[KEY_NAME]) return process.env[KEY_NAME];
  if (existsSync(KEYS)) {
    const key = parseFile(KEYS)[KEY_NAME];
    if (key) return key;
  }
  fail(`no ${KEY_NAME}. Ask a teammate for it and put it in ${KEYS} as ${KEY_NAME}=<key>.`);
}

// Bare when it's safe for `node --env-file`, else double-quoted.
function format(key, value) {
  if (/^[\w.:/+=@,-]*$/.test(value)) return `${key}=${value}`;
  if (value.includes('\n') || (value.includes('"') && value.includes("'"))) {
    fail(`${key} has a newline or both quote kinds; set it in ${LOCAL} by hand`);
  }
  return value.includes('"') ? `${key}='${value}'` : `${key}="${value}"`;
}

function pull() {
  if (!existsSync(SHARED)) fail(`${SHARED} not found; run from the repo root`);
  const encrypted = parseFile(SHARED);
  delete encrypted[PUBLIC_KEY];
  const unknown = Object.keys(encrypted).filter((k) => !SHARED_KEYS.includes(k));
  if (unknown.length > 0) fail(`${SHARED} has keys that aren't shared: ${unknown.join(', ')}`);
  const plain = Object.keys(encrypted).filter((k) => !encrypted[k].startsWith(ENCRYPTED));
  if (plain.length > 0) fail(`${SHARED} has unencrypted values for ${plain.join(', ')}`);

  const key = privateKey();
  const shared = {};
  for (const [name, value] of Object.entries(encrypted)) {
    try {
      shared[name] = decrypt(key, value);
    } catch (error) {
      fail(`could not decrypt ${name}: ${error.message}`);
    }
  }

  if (!existsSync(LOCAL)) {
    if (!existsSync(EXAMPLE)) fail(`${LOCAL} and ${EXAMPLE} not found; run from the repo root`);
    copyFileSync(EXAMPLE, LOCAL);
    console.log(`created ${LOCAL} from ${EXAMPLE}`);
  }

  const lines = readFileSync(LOCAL, 'utf8').split('\n');
  const pending = new Map(Object.entries(shared));
  const changed = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(lines[i])?.[1];
    if (key === undefined || !pending.has(key)) continue;
    const line = format(key, pending.get(key));
    if (lines[i] !== line) changed.push(key);
    lines[i] = line;
    pending.delete(key);
  }
  if (pending.size > 0) {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    if (!lines.includes(HEADER)) lines.push('', HEADER);
    for (const [key, value] of pending) {
      lines.push(format(key, value));
      changed.push(key);
    }
    lines.push('');
  }

  writeFileSync(LOCAL, lines.join('\n'), { mode: 0o600 });
  chmodSync(LOCAL, 0o600);
  const unchanged = Object.keys(shared).length - changed.length;
  console.log(
    changed.length > 0
      ? `updated ${changed.join(', ')} in ${LOCAL}; ${unchanged} already current`
      : `${LOCAL} already has all ${unchanged} shared values`,
  );
}

async function share(keys) {
  if (keys.length === 0) fail('name the keys to share, e.g. pnpm env:share OPENROUTER_API_KEY');
  if (!existsSync(LOCAL)) fail(`${LOCAL} not found; run from the repo root`);
  // The first share creates .env.shared and the key pair in .env.keys. Later shares encrypt
  // with the public key in .env.shared, so they don't need the private key.
  const local = parseFile(LOCAL);
  const unknown = keys.filter((k) => !SHARED_KEYS.includes(k));
  if (unknown.length > 0) {
    fail(`${unknown.join(', ')} not in SHARED_KEYS; add it in scripts/env-sync.js first`);
  }
  for (const key of keys) {
    const value = local[key];
    if (value === undefined || value === '') fail(`${key} is not set in ${LOCAL}`);
    const { processedEnvs } = await dotenvx.set(key, value, {
      path: SHARED,
      envKeysFile: KEYS,
      ...LOCAL_ONLY,
    });
    const error = processedEnvs.find((env) => env.error)?.error;
    if (error) fail(`could not share ${key}: ${error.message}`);
  }
  console.log(`commit ${SHARED}; teammates then run pnpm env:pull`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'pull') pull();
else if (command === 'share') await share(args);
else fail('usage: node scripts/env-sync.js pull | share KEY...');
