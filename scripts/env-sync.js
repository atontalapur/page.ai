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
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Bare when it's safe for `node --env-file`, else single-quoted, which Node reads literally.
// Double quotes are the fallback only without a backslash, since Node expands `\n` in them.
function format(key, value) {
  if (/^[\w.:/+=@,-]*$/.test(value)) return `${key}=${value}`;
  if (value.includes('\n')) fail(`${key} has a newline; set it in ${LOCAL} by hand`);
  if (!value.includes("'")) return `${key}='${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `${key}="${value}"`;
  fail(`${key} has a quote mix that ${LOCAL} can't hold literally; set it by hand`);
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

  // Rewrite every line that sets a shared key, not just the first: `node --env-file` uses the
  // last definition, so a stale duplicate further down would win.
  const lines = readFileSync(LOCAL, 'utf8').split('\n');
  const pending = new Map(Object.entries(shared));
  const changed = new Set();
  for (let i = 0; i < lines.length; i++) {
    const key = /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(lines[i])?.[1];
    if (key === undefined || !Object.hasOwn(shared, key)) continue;
    const line = format(key, shared[key]);
    if (lines[i] !== line) changed.add(key);
    lines[i] = line;
    pending.delete(key);
  }
  if (pending.size > 0) {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    if (!lines.includes(HEADER)) lines.push('', HEADER);
    for (const [key, value] of pending) {
      lines.push(format(key, value));
      changed.add(key);
    }
    lines.push('');
  }

  writeFileSync(LOCAL, lines.join('\n'), { mode: 0o600 });
  chmodSync(LOCAL, 0o600);
  const unchanged = Object.keys(shared).length - changed.size;
  console.log(
    changed.size > 0
      ? `updated ${[...changed].join(', ')} in ${LOCAL}; ${unchanged} already current`
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
  // Check every key before writing any, so a bad key can't leave .env.shared half-updated.
  const unset = keys.filter((k) => local[k] === undefined || local[k] === '');
  if (unset.length > 0) fail(`${unset.join(', ')} not set in ${LOCAL}`);
  // dotenvx.set keeps a value plaintext when .env.shared already holds that key in plaintext.
  const before = existsSync(SHARED) ? readFileSync(SHARED, 'utf8') : undefined;
  const existing = before === undefined ? {} : parseEnv(before);
  const plain = keys.filter(
    (k) => Object.hasOwn(existing, k) && !existing[k].startsWith(ENCRYPTED),
  );
  if (plain.length > 0) {
    fail(`${SHARED} has ${plain.join(', ')} unencrypted; remove those lines and share again`);
  }

  // Put .env.shared back as it was if anything below fails, so nothing partial is committed.
  const abort = (message) => {
    if (before === undefined) rmSync(SHARED, { force: true });
    else writeFileSync(SHARED, before);
    fail(`${message}; ${SHARED} left unchanged`);
  };
  for (const key of keys) {
    const { processedEnvs } = await dotenvx.set(key, local[key], {
      path: SHARED,
      envKeysFile: KEYS,
      ...LOCAL_ONLY,
    });
    const error = processedEnvs.find((env) => env.error)?.error;
    if (error) abort(`could not share ${key}: ${error.message}`);
  }
  const written = parseFile(SHARED);
  const leaked = keys.filter((k) => !written[k]?.startsWith(ENCRYPTED));
  if (leaked.length > 0) abort(`dotenvx did not encrypt ${leaked.join(', ')}`);
  console.log(`commit ${SHARED}; teammates then run pnpm env:pull`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'pull') pull();
else if (command === 'share') await share(args);
else fail('usage: node scripts/env-sync.js pull | share KEY...');
