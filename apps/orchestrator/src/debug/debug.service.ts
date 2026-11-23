import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DebugErrorKind, DebugResult, DebugState } from '@page/contracts';
import type { Config, DebugTools } from '../config.ts';
import type { Logger } from '../logger.ts';
import { CONFIG, LOGGER } from '../tokens.ts';

// Scenario 029's bug: valid as a setting, but past int4 once a checkout stores it.
const SHIPPING_KEY = 'SHIPPING_FLAT_CENTS';
const SHIPPING_TOO_BIG = '2500000000';
// A product that pays shipping in the seeded catalogue, as scenario 029's trigger uses.
const CHECKOUT_PRODUCT = 'field-notebook';
// How long a restarted demo app gets to answer /api/health again.
const HEALTHY_WITHIN_MS = 90_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Off: the Debugging page's routes answer 404. */
export class DebugToolsOff extends Error {
  constructor() {
    super('Debugging tools are off. Set DEBUG_TOOLS, DEMO_APP_URL and OPS_SECRET.');
  }
}

/** GET /api/products: the catalogue, as an array. */
type Products = { id?: unknown; slug?: unknown }[];

const asProducts = (body: unknown): Products => (Array.isArray(body) ? (body as Products) : []);

/**
 * Test errors on the staging demo app, for the dashboard's Debugging page. Every request to
 * the app or to PostHog goes from here, so OPS_SECRET and the PostHog key never reach a
 * browser. Each error comes in through the real path: the demo app reports it to PostHog,
 * whose webhook opens the issue.
 */
@Injectable()
export class DebugService {
  private readonly tools: DebugTools | undefined;
  /** Waits between restart checks. Tests make it immediate. */
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.tools = config.debug;
  }

  async state(): Promise<DebugState> {
    const tools = this.on();
    const healthy = await this.healthy(tools);
    return {
      demoAppUrl: tools.demoAppUrl,
      healthy,
      overrides: healthy ? await this.overrides(tools) : [],
      codeBugLive: healthy ? await this.codeBugLive(tools) : null,
      canSendSynthetic: tools.posthog !== undefined,
    };
  }

  async create(kind: DebugErrorKind): Promise<DebugResult> {
    const tools = this.on();
    this.logger.info({ kind }, 'creating a test error');
    switch (kind) {
      case 'checkout':
        return this.breakCheckout(tools);
      case 'code_bug':
        return this.hitCodeBug(tools);
      case 'synthetic':
        return this.sendSynthetic(tools);
    }
  }

  /** Clears every runtime override and restarts the app, so it serves its own settings. */
  async reset(): Promise<DebugResult> {
    const tools = this.on();
    const overrides = await this.overrides(tools);
    for (const { key } of overrides) {
      await this.ops(tools, 'DELETE', `/api/ops/config/${encodeURIComponent(key)}`);
    }
    await this.restart(tools);
    return {
      ok: true,
      status: null,
      message:
        overrides.length === 0
          ? 'The demo app had no overrides; it restarted on its own settings.'
          : `Cleared ${overrides.map((o) => o.key).join(', ')} and restarted the demo app.`,
    };
  }

  private on(): DebugTools {
    if (!this.tools) throw new DebugToolsOff();
    return this.tools;
  }

  private async breakCheckout(tools: DebugTools): Promise<DebugResult> {
    await this.ops(tools, 'PUT', `/api/ops/config/${SHIPPING_KEY}`, { value: SHIPPING_TOO_BIG });
    await this.restart(tools);
    const status = await this.checkout(tools);
    return status === 500
      ? {
          ok: true,
          status,
          message: `Set ${SHIPPING_KEY} to ${SHIPPING_TOO_BIG} and checked out a ${CHECKOUT_PRODUCT}: the order failed with 500. The demo app reports it to PostHog, which opens an issue. Reset the demo app when you are done.`,
        }
      : {
          ok: false,
          status,
          message: `Set ${SHIPPING_KEY}, but the checkout answered ${status}, not 500. Reset the demo app and try again.`,
        };
  }

  private async hitCodeBug(tools: DebugTools): Promise<DebugResult> {
    const slug = (await this.productSlug(tools)) ?? CHECKOUT_PRODUCT;
    const res = await this.get(tools, `/api/products/${encodeURIComponent(slug)}`);
    return res.status >= 500
      ? {
          ok: true,
          status: res.status,
          message: `GET /api/products/${slug} failed with ${res.status}: the code bug is live, and PostHog will open an issue for it.`,
        }
      : {
          ok: false,
          status: res.status,
          message: `GET /api/products/${slug} answered ${res.status}, so no code bug is live. Seed one with infra/sandbox/demo-sync.sh.`,
        };
  }

  private async sendSynthetic(tools: DebugTools): Promise<DebugResult> {
    if (!tools.posthog) {
      return { ok: false, status: null, message: 'Set POSTHOG_KEY to send a test exception.' };
    }
    // A fresh message each time, so PostHog groups it into an issue of its own.
    const stamp = new Date().toISOString();
    const res = await fetch(`${tools.posthog.host.replace(/\/$/, '')}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        api_key: tools.posthog.key,
        event: '$exception',
        distinct_id: 'page-ai-debugging',
        uuid: randomUUID(),
        timestamp: stamp,
        properties: {
          $lib: 'page-ai-debugging',
          $exception_list: [
            {
              type: 'Error',
              value: `Debugging page test exception at ${stamp}`,
              mechanism: { handled: false, type: 'generic', synthetic: false },
              stacktrace: {
                type: 'raw',
                frames: [
                  {
                    platform: 'custom',
                    lang: 'javascript',
                    function: 'debuggingPageTest',
                    filename: 'debugging-page.ts',
                    lineno: 1,
                    colno: 1,
                    in_app: true,
                    resolved: true,
                  },
                ],
              },
            },
          ],
        },
      }),
    });
    return res.ok
      ? {
          ok: true,
          status: res.status,
          message:
            'Sent a test exception to PostHog. Its webhook opens an issue in a few seconds; nothing in the app is broken, so a fix finds nothing.',
        }
      : { ok: false, status: res.status, message: `PostHog answered ${res.status}.` };
  }

  /** Adds the product to a fresh cart and places the order. Returns the order's status. */
  private async checkout(tools: DebugTools): Promise<number> {
    const products = asProducts(await (await this.get(tools, '/api/products')).json());
    const product = products.find((p) => p.slug === CHECKOUT_PRODUCT);
    if (typeof product?.id !== 'number') {
      throw new Error(`the demo app has no ${CHECKOUT_PRODUCT} product to check out`);
    }
    const added = await fetch(`${tools.demoAppUrl}/api/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: product.id }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!added.ok) throw new Error(`adding to the cart answered ${added.status}`);
    // The cart lives in a cookie; carry it to the order.
    const cookie = added.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const order = await fetch(`${tools.demoAppUrl}/api/orders`, {
      method: 'POST',
      headers: { cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return order.status;
  }

  private async overrides(tools: DebugTools): Promise<DebugState['overrides']> {
    const res = await this.ops(tools, 'GET', '/api/ops/config');
    const body = (await res.json()) as { settings?: { key: string; override: string | null }[] };
    return (body.settings ?? [])
      .filter((s) => s.override !== null)
      .map((s) => ({ key: s.key, value: s.override as string }));
  }

  private async codeBugLive(tools: DebugTools): Promise<boolean | null> {
    const slug = await this.productSlug(tools);
    if (!slug) return null;
    return (await this.get(tools, `/api/products/${encodeURIComponent(slug)}`)).status >= 500;
  }

  private async productSlug(tools: DebugTools): Promise<string | undefined> {
    const res = await this.get(tools, '/api/products');
    if (!res.ok) return undefined;
    const slug = asProducts(await res.json())[0]?.slug;
    return typeof slug === 'string' ? slug : undefined;
  }

  private async healthy(tools: DebugTools): Promise<boolean> {
    try {
      return (await this.get(tools, '/api/health')).ok;
    } catch {
      return false;
    }
  }

  private async restart(tools: DebugTools): Promise<void> {
    await this.ops(tools, 'POST', '/api/ops/restart');
    const deadline = Date.now() + HEALTHY_WITHIN_MS;
    // The app exits a moment after answering; give it that before asking again.
    await this.sleep(3_000);
    while (Date.now() < deadline) {
      if (await this.healthy(tools)) return;
      await this.sleep(2_000);
    }
    throw new Error(`the demo app was not healthy ${HEALTHY_WITHIN_MS / 1000}s after a restart`);
  }

  private get(tools: DebugTools, path: string): Promise<Response> {
    return fetch(`${tools.demoAppUrl}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async ops(
    tools: DebugTools,
    method: string,
    path: string,
    body?: object,
  ): Promise<Response> {
    const res = await fetch(`${tools.demoAppUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tools.opsSecret}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `the demo app's ${method} ${path} answered ${res.status}: ${await res.text()}`,
      );
    }
    return res;
  }
}
