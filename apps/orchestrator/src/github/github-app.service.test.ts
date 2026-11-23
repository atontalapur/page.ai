import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { GitHubAppError, GitHubAppService } from './github-app.service.ts';
import { decrypt, encrypt } from './secrets.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());
afterEach(() => vi.unstubAllGlobals());

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const config = { ...deps.config, github: undefined };
const appService = () => new GitHubAppService(deps.db, config, deps.logger, null);

/** GitHub's app endpoints. Every JWT it gets must verify against the app's public key. */
function github() {
  const jwts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get('authorization') ?? '';
      const json = (body: unknown, status = 200) =>
        Promise.resolve(Response.json(body, { status }));
      if (url.includes('/app-manifests/good-code/conversions')) {
        return json({
          id: 42,
          slug: 'pageagents-1a2b',
          html_url: 'https://github.com/apps/pageagents-1a2b',
          owner: { login: 'nidheesh' },
          pem,
          webhook_secret: 'hook-secret-from-github',
        });
      }
      if (
        url.endsWith('/app/installations/7') ||
        url.endsWith('/app/installations/7/access_tokens')
      ) {
        jwts.push(auth.slice('Bearer '.length));
        return url.endsWith('access_tokens')
          ? json({
              token: 'ghs_installation',
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            })
          : json({ id: 7 });
      }
      if (url.endsWith('/app/installations/8')) return json({ message: 'Not Found' }, 404);
      if (url.includes('/installation/repositories')) {
        return json({ repositories: [{ full_name: 'nidheesh/page-demo' }] });
      }
      return json({ message: 'unexpected' }, 500);
    }),
  );
  return jwts;
}

describe('GitHubAppService', () => {
  it('creates, installs and then mints tokens for the app, with its key encrypted at rest', async () => {
    const jwts = github();
    const app = appService();
    const { action, manifest, state } = app.manifest();
    expect(action).toBe(`https://github.com/settings/apps/new?state=${state}`);
    const parsed = JSON.parse(manifest) as {
      hook_attributes: { url: string };
      default_events: string[];
    };
    expect(parsed.hook_attributes.url).toBe(
      `${config.dashboardUrl.replace(/\/$/, '')}/ingest/github`,
    );
    expect(parsed.default_events).toEqual(
      expect.arrayContaining(['pull_request_review', 'issue_comment']) as unknown,
    );

    expect(await app.created('good-code', state)).toBe(
      'https://github.com/apps/pageagents-1a2b/installations/new',
    );
    const row = await deps.db.selectFrom('github_app').selectAll().executeTakeFirstOrThrow();
    expect(row.private_key_enc).not.toContain('PRIVATE KEY');
    expect(decrypt(row.private_key_enc, config.secretsKey!)).toBe(pem);

    expect(await app.installed(7)).toBe('nidheesh/page-demo');
    expect(await app.token()).toMatchObject({
      token: 'ghs_installation',
      repo: 'nidheesh/page-demo',
    });
    expect(await app.status()).toMatchObject({
      app: { bot: 'pageagents-1a2b[bot]', installed: true, repo: 'nidheesh/page-demo' },
    });
    expect(await app.webhookSecrets()).toEqual(['hook-secret-from-github']);

    const [header, payload, signature] = jwts[0]!.split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iss: '42' });
    const ok = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);
  });

  it('refuses a callback whose state it did not issue, and reuse of one it did', async () => {
    github();
    const app = appService();
    await expect(app.created('good-code', 'f'.repeat(48))).rejects.toBeInstanceOf(GitHubAppError);
    const { state } = app.manifest();
    await app.created('good-code', state);
    await expect(app.created('good-code', state)).rejects.toBeInstanceOf(GitHubAppError);
  });

  it("refuses an installation that GitHub says isn't the app's", async () => {
    github();
    await expect(appService().installed(8)).rejects.toBeInstanceOf(GitHubAppError);
  });

  it('cannot start without SECRETS_KEY', () => {
    const app = new GitHubAppService(
      deps.db,
      { ...config, secretsKey: undefined },
      deps.logger,
      null,
    );
    expect(() => app.manifest()).toThrow(/SECRETS_KEY/);
  });
});

describe('secrets', () => {
  it('round-trips, and fails closed on the wrong key or a changed ciphertext', () => {
    const key = 'k'.repeat(32);
    const sealed = encrypt('hello', key);
    expect(decrypt(sealed, key)).toBe('hello');
    expect(() => decrypt(sealed, 'x'.repeat(32))).toThrow();
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => decrypt(raw.toString('base64'), key)).toThrow();
  });
});
