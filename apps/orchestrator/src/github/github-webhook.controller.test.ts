import { createHmac } from 'node:crypto';
import { NotFoundException, type RawBodyRequest } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps } from '../db/test-utils.ts';
import type { GitHubAppService } from './github-app.service.ts';
import { GitHubWebhookController } from './github-webhook.controller.ts';
import type { GitHubReviewService } from './github-review.service.ts';

// The whole app, since the signature is checked over the raw body, which only Fastify's
// rawBody option keeps. A request a handler ignores says why, so its reason shows which
// handler it reached without a call to GitHub.
const secret = 'w'.repeat(20);
const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(
  {
    ...deps,
    config: { ...deps.config, github: { token: 't', repo: 'o/r', webhookSecret: secret } },
  },
  false,
);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const sign = (body: string, key = secret) =>
  `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

function post(event: string | undefined, payload: unknown, signature?: string) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/ingest/github',
    headers: {
      'content-type': 'application/json',
      ...(event === undefined ? {} : { 'x-github-event': event }),
      'x-hub-signature-256': signature ?? sign(body),
    },
    payload: body,
  });
}

describe('POST /ingest/github', () => {
  it('answers 404 while neither a GitHub App nor GITHUB_WEBHOOK_SECRET is set up', async () => {
    // The app above has a secret, so this one calls the controller with none.
    const unset = new GitHubWebhookController(
      { webhookSecrets: () => Promise.resolve<string[]>([]) } as GitHubAppService,
      {} as GitHubReviewService,
    );
    const request = { rawBody: Buffer.from('{}') } as RawBodyRequest<FastifyRequest>;
    await expect(unset.receive(request, 'ping', sign('{}'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuses a body without GitHub's signature under the webhook secret", async () => {
    const body = JSON.stringify({ zen: 'hi' });
    expect((await post('ping', { zen: 'hi' }, '')).statusCode).toBe(401);
    expect((await post('ping', { zen: 'hi' }, sign(body, 'x'.repeat(20)))).statusCode).toBe(401);
    // Signed, then changed on the way.
    expect((await post('ping', { zen: 'bye' }, sign(body))).statusCode).toBe(401);
  });

  it('checks the signature over the bytes GitHub sent, not the parsed JSON', async () => {
    // GitHub's bodies aren't compact JSON, so a signature over a re-serialized body fails.
    const res = await post('ping', '{\n  "zen": "hi"\n}');
    expect(res.statusCode).toBe(200);
  });

  it('answers a ping', async () => {
    const res = await post('ping', { zen: 'hi' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'ignored', why: 'ping' });
  });

  it('hands a pull request event to the review service', async () => {
    const res = await post('pull_request', {
      action: 'opened',
      pull_request: { number: 1, head: { ref: 'feature/x' } },
    });
    expect(res.json()).toEqual({ kind: 'ignored', why: 'not an agent branch' });
  });

  it('hands a comment to the review service', async () => {
    const res = await post('issue_comment', { action: 'created', issue: { number: 1 } });
    expect(res.json()).toEqual({ kind: 'ignored', why: 'not a new comment on a PR' });
  });

  it('ignores any other event, and one with no event name', async () => {
    for (const event of ['push', undefined]) {
      const res = await post(event, { ref: 'refs/heads/main' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: 'ignored', why: 'not a pull request event' });
    }
  });
});
