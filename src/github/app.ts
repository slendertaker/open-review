/**
 * GitHub auth helpers (D-16).
 *
 * App mode (primary): mint short-lived installation tokens via @octokit/auth-app.
 * PAT mode (fallback): simple GITHUB_TOKEN static auth.
 *
 * Phase 1 ships PAT mode only for the skeleton; App mode is available for callers
 * that supply appId + privateKey + installationId (plan 05 completes App wiring).
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

/**
 * Build an Octokit client authenticated as the given App installation.
 * Reviews posted through this client appear authored by the bot identity.
 */
export function installationOctokit(creds: AppCredentials, installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: creds.appId,
      privateKey: creds.privateKey,
      installationId,
    },
  });
}

/**
 * Mint a raw installation access token for git clone/fetch operations.
 */
export async function installationToken(
  creds: AppCredentials,
  installationId: number,
): Promise<string> {
  const auth = createAppAuth({
    appId: creds.appId,
    privateKey: creds.privateKey,
  });
  const { token } = await auth({ type: 'installation', installationId });
  return token;
}

/**
 * Build an Octokit client authenticated as the App (no installationId).
 * Used for App-level routes such as listing all installations.
 * @octokit/auth-app auto-selects App JWT for routes under /app/*.
 */
export function appLevelOctokit(creds: AppCredentials): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: creds.appId,
      privateKey: creds.privateKey,
    },
  });
}

/**
 * Build a PAT-authenticated Octokit client (single-repo fallback).
 */
export function patOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}
