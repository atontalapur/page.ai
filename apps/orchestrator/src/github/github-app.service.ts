import { createSign, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { GitHubAppStatus } from '@page/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import type { Logger } from '../logger.ts';
import { CONFIG, DB, GITHUB, LOGGER } from '../tokens.ts';
import { RestGitHubApi, type GitHubApi } from './github-api.ts';
import { decrypt, encrypt } from './secrets.ts';

const API = 'https://api.github.com';
// How long a manifest's state may wait for GitHub's redirect back.
const STATE_TTL_MS = 30 * 60_000;
// An installation token lasts an hour; one with less than this left is minted again.
const TOKEN_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

/** A request the app can't meet, such as a callback without a state this server issued. */
export class GitHubAppError extends Error {}

const conversionSchema = z.object({
  id: z.number(),
  slug: z.string(),
  html_url: z.string(),
  owner: z.object({ login: z.string() }),
  pem: z.string(),
  webhook_secret: z.string(),
});

const tokenSchema = z.object({ token: z.string(), expires_at: z.string() });

export interface InstallationToken {
  token: string;
  repo: string;
  expiresAt: string;
}

/**
 * The GitHub App the agents act as, created from the dashboard through GitHub's manifest
 * flow: the dashboard posts a manifest to GitHub, GitHub sends the person back with a code,
 * and this swaps it for the app's id, private key and webhook secret, which it keeps
 * encrypted. Installing the app on the demo repo records the installation. From then on
 * every GitHub call, the orchestrator's and the node's, uses an hour-long installation
 * token signed with the app's key, and PRs come from `<slug>[bot]`.
 *
 * `api()` is the one way in to the demo repo: a client given to the app (tests), else the
 * installed app, else GITHUB_TOKEN from the env.
 */
@Injectable()
export class GitHubAppService {
  private readonly states = new Map<string, number>();
  private cached: InstallationToken | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(GITHUB) private readonly given: GitHubApi | null,
  ) {}

  async status(): Promise<GitHubAppStatus> {
    const app = await this.row();
    const pat = this.config.github;
    return {
      canCreate: this.config.secretsKey !== undefined,
      app: app
        ? {
            slug: app.slug,
            url: app.html_url,
            owner: app.owner,
            bot: `${app.slug}[bot]`,
            installed: app.installation_id !== null,
            repo: app.repo,
            installUrl: `${app.html_url}/installations/new`,
          }
        : null,
      // The token in the env, used until the app is installed.
      fallback: pat ? { repo: pat.repo } : null,
    };
  }

  /** The manifest the dashboard posts to GitHub, with a state its callback must return. */
  manifest(): { action: string; manifest: string; state: string } {
    if (!this.config.secretsKey) {
      throw new GitHubAppError('Set SECRETS_KEY on the orchestrator to create a GitHub App.');
    }
    const now = Date.now();
    for (const [state, expires] of this.states) if (expires < now) this.states.delete(state);
    const state = randomBytes(24).toString('hex');
    this.states.set(state, now + STATE_TTL_MS);
    const base = this.config.dashboardUrl.replace(/\/$/, '');
    const manifest = {
      name: `PageAgents ${randomBytes(2).toString('hex')}`,
      url: base,
      description: 'Opens and updates the PageAgents fix PRs, and hears their reviews.',
      public: false,
      hook_attributes: { url: `${base}/ingest/github`, active: true },
      redirect_url: `${base}/github/app/callback`,
      setup_url: `${base}/github/app/setup`,
      setup_on_update: true,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'read',
        metadata: 'read',
      },
      default_events: [
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'issue_comment',
      ],
    };
    return {
      action: `https://github.com/settings/apps/new?state=${state}`,
      manifest: JSON.stringify(manifest),
      state,
    };
  }

  /** GitHub's redirect after the app is created: keeps the app, returns where to install it. */
  async created(code: string, state: string): Promise<string> {
    const key = this.config.secretsKey;
    const expires = this.states.get(state);
    this.states.delete(state);
    if (!key || expires === undefined || expires < Date.now()) {
      throw new GitHubAppError(
        'That GitHub App link expired or was not started here. Start again from Settings.',
      );
    }
    const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubAppError(`GitHub answered ${res.status} to the app's code.`);
    const app = conversionSchema.parse(await res.json());
    const row = {
      app_id: app.id,
      slug: app.slug,
      html_url: app.html_url,
      owner: app.owner.login,
      private_key_enc: encrypt(app.pem, key),
      webhook_secret_enc: encrypt(app.webhook_secret, key),
      installation_id: null,
      repo: null,
      installed_at: null,
    };
    await this.db
      .insertInto('github_app')
      .values({ id: 1, ...row })
      .onConflict((oc) => oc.column('id').doUpdateSet(row))
      .execute();
    this.cached = undefined;
    this.logger.info({ slug: app.slug, owner: app.owner.login }, 'GitHub App created');
    return `${app.html_url}/installations/new`;
  }

  /**
   * GitHub's redirect after the app is installed. The installation id is checked against
   * GitHub with the app's own key, so a made-up id is refused.
   */
  async installed(installationId: number): Promise<string> {
    const app = await this.row();
    if (!app) throw new GitHubAppError('No GitHub App has been created here yet.');
    const jwt = this.jwt(app);
    const check = await fetch(`${API}/app/installations/${installationId}`, {
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!check.ok)
      throw new GitHubAppError(`That installation is not this app's (${check.status}).`);
    const token = await this.mint(app, installationId);
    const repos = z
      .object({ repositories: z.array(z.object({ full_name: z.string() })) })
      .parse(
        await (
          await fetch(`${API}/installation/repositories?per_page=100`, {
            headers: {
              authorization: `Bearer ${token.token}`,
              accept: 'application/vnd.github+json',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        ).json(),
      )
      .repositories.map((r) => r.full_name);
    const want = this.config.github?.repo;
    const repo = want && repos.includes(want) ? want : repos[0];
    if (!repo) throw new GitHubAppError('Install the app on the demo repo, then try again.');
    await this.db
      .updateTable('github_app')
      .set({ installation_id: installationId, repo, installed_at: sql<Date>`now()` })
      .where('id', '=', 1)
      .execute();
    this.cached = { token: token.token, repo, expiresAt: token.expiresAt };
    this.logger.info({ installationId, repo }, 'GitHub App installed');
    return repo;
  }

  /** An installation token for the demo repo, minted again near its expiry; null without an app. */
  async token(): Promise<InstallationToken | null> {
    if (this.cached && Date.parse(this.cached.expiresAt) - Date.now() > TOKEN_MARGIN_MS) {
      return this.cached;
    }
    const app = await this.row();
    if (!app || app.installation_id === null || app.repo === null) return null;
    const minted = await this.mint(app, Number(app.installation_id));
    this.cached = { token: minted.token, repo: app.repo, expiresAt: minted.expiresAt };
    return this.cached;
  }

  /** The demo repo, as the app if it is installed, else with GITHUB_TOKEN; null with neither. */
  async api(): Promise<GitHubApi | null> {
    if (this.given) return this.given;
    const app = await this.token();
    if (app) {
      return new RestGitHubApi(async () => (await this.token())?.token ?? app.token, app.repo);
    }
    const pat = this.config.github;
    return pat ? new RestGitHubApi(pat.token, pat.repo) : null;
  }

  /** Every secret a webhook delivery may be signed with: the app's, and GITHUB_WEBHOOK_SECRET. */
  async webhookSecrets(): Promise<string[]> {
    const secrets: string[] = [];
    const app = await this.row();
    if (app && this.config.secretsKey) {
      try {
        secrets.push(decrypt(app.webhook_secret_enc, this.config.secretsKey));
      } catch (error) {
        this.logger.error(
          { err: error },
          'could not decrypt the GitHub App webhook secret; is SECRETS_KEY the one it was made with?',
        );
      }
    }
    if (this.config.github) secrets.push(this.config.github.webhookSecret);
    return secrets;
  }

  private row() {
    return this.db.selectFrom('github_app').selectAll().where('id', '=', 1).executeTakeFirst();
  }

  /** A ten-minute app JWT, signed RS256 with the app's private key. */
  private jwt(app: { app_id: string | number; private_key_enc: string }): string {
    const key = this.config.secretsKey;
    if (!key) throw new GitHubAppError('SECRETS_KEY is unset, so the app key cannot be read.');
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(app.app_id) })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(decrypt(app.private_key_enc, key))
      .toString('base64url');
    return `${unsigned}.${signature}`;
  }

  private async mint(
    app: { app_id: string | number; private_key_enc: string },
    installationId: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.jwt(app)}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubAppError(`GitHub refused an installation token (${res.status}).`);
    const body = tokenSchema.parse(await res.json());
    return { token: body.token, expiresAt: body.expires_at };
  }
}
