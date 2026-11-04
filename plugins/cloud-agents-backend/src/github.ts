import type { GithubAppConfig } from './config';

export interface GithubTokens {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

function expiresAt(seconds: number | undefined, now: number): string | null {
  return seconds ? new Date(now + seconds * 1000).toISOString() : null;
}

/**
 * The GitHub calls the plugin makes: the GitHub App user authorization web
 * flow, its token refresh, and reading the login of a token.
 */
export class GithubClient {
  constructor(
    private readonly apiBaseUrl: string,
    readonly app: GithubAppConfig | undefined,
  ) {}

  private requireApp(): GithubAppConfig {
    if (!this.app) {
      throw new Error('No GitHub App is configured for cloud agents');
    }
    return this.app;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const app = this.requireApp();
    const url = new URL('/login/oauth/authorize', app.webBaseUrl);
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async tokenRequest(
    params: Record<string, string>,
  ): Promise<GithubTokens> {
    const app = this.requireApp();
    const now = Date.now();
    const response = await fetch(
      new URL('/login/oauth/access_token', app.webBaseUrl),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          ...params,
        }),
      },
    );
    const body = (await response.json()) as TokenResponse;
    if (!response.ok || body.error || !body.access_token) {
      throw new Error(
        `GitHub token request failed: ${
          body.error_description ?? body.error ?? response.status
        }`,
      );
    }
    return {
      accessToken: body.access_token,
      accessTokenExpiresAt: expiresAt(body.expires_in, now),
      refreshToken: body.refresh_token ?? null,
      refreshTokenExpiresAt: expiresAt(body.refresh_token_expires_in, now),
    };
  }

  exchangeCode(code: string, redirectUri: string): Promise<GithubTokens> {
    return this.tokenRequest({ code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<GithubTokens> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  async getLogin(token: string): Promise<string> {
    const response = await fetch(new URL('user', `${this.apiBaseUrl}/`), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'backstage-plugin-cloud-agents',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub rejected the token (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { login?: string };
    if (!body.login) throw new Error('GitHub returned no login for the token');
    return body.login;
  }
}
