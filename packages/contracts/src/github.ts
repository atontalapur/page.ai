import { z } from 'zod';

/** The agents' GitHub identity, for the dashboard's Settings page. */
export const gitHubAppStatusSchema = z.strictObject({
  /** SECRETS_KEY is set, so the dashboard may create an app. */
  canCreate: z.boolean(),
  app: z
    .strictObject({
      slug: z.string(),
      url: z.string(),
      owner: z.string(),
      /** The login PRs come from, such as `pageagents-1a2b[bot]`. */
      bot: z.string(),
      installed: z.boolean(),
      repo: z.string().nullable(),
      installUrl: z.string(),
    })
    .nullable(),
  /** A personal token from the env, used until the app is installed. */
  fallback: z.strictObject({ repo: z.string() }).nullable(),
});
export type GitHubAppStatus = z.infer<typeof gitHubAppStatusSchema>;

/** A short-lived installation token the node uses to push and open PRs. */
export const gitHubTokenSchema = z.strictObject({
  token: z.string(),
  repo: z.string(),
  expiresAt: z.string(),
});
export type GitHubToken = z.infer<typeof gitHubTokenSchema>;
