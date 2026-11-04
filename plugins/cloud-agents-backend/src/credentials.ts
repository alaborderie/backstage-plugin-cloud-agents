import { InputError } from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type {
  CodexCredentialKind,
  CredentialName,
  CredentialsSummary,
  Harness,
} from '@alaborderie/plugin-cloud-agents-common';
import type { CredentialCipher } from './crypto';
import type { GithubClient, GithubTokens } from './github';
import { nowIso, type Store } from './store';

/** A credential the user has not set, or that no longer works. */
export class MissingCredentialError extends Error {
  constructor(readonly harness: Harness, readonly credential: CredentialName) {
    super(`missing ${credential} credential`);
  }
}

interface HarnessMeta {
  kind?: CodexCredentialKind;
}

interface GithubMeta {
  login: string;
  method: 'oauth' | 'token';
}

interface StoredGithub extends GithubTokens {
  method: 'oauth' | 'token';
}

/** What one run's Secret holds besides the prompt. */
export interface RunCredentials {
  env: Record<string, string>;
  /** A ChatGPT `auth.json`, mounted as a file for `CODEX_AUTH_JSON`. */
  codexAuthJson: string | undefined;
}

/**
 * Which environment variables each harness reads (runner/README.md
 * "Credentials"). A run gets its harness's entry and `GH_TOKEN`, nothing else.
 */
const HARNESS_CREDENTIAL: Record<
  Harness,
  (value: string, meta: HarnessMeta) => RunCredentials
> = {
  claude: value => ({
    env: { CLAUDE_CODE_OAUTH_TOKEN: value },
    codexAuthJson: undefined,
  }),
  codex: (value, meta): RunCredentials =>
    meta.kind === 'auth_json'
      ? { env: {}, codexAuthJson: value }
      : { env: { CODEX_API_KEY: value }, codexAuthJson: undefined },
  opencode: value => ({
    env: { OPENCODE_API_KEY: value },
    codexAuthJson: undefined,
  }),
};

/** Refresh a GitHub user token when it has less than this left. */
const GITHUB_MIN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Per-user credentials, sealed with AES-256-GCM. Values go in through `put*`
 * and out only into a run's Secret; nothing here logs or returns them.
 */
export class CredentialService {
  constructor(
    private readonly store: Store,
    private readonly cipher: CredentialCipher,
    private readonly github: GithubClient,
    private readonly logger: LoggerService,
  ) {}

  private aad(owner: string, name: CredentialName): string {
    return `${owner}\n${name}`;
  }

  async summary(owner: string): Promise<CredentialsSummary> {
    const rows = new Map(
      (await this.store.listCredentials(owner)).map(r => [r.name, r]),
    );
    const meta = <T>(name: string): Partial<T> =>
      JSON.parse(rows.get(name)?.meta ?? '{}') as Partial<T>;
    const github = meta<GithubMeta>('github');
    return {
      claude: {
        set: rows.has('claude'),
        updatedAt: rows.get('claude')?.updated_at ?? null,
      },
      codex: {
        set: rows.has('codex'),
        kind: meta<HarnessMeta>('codex').kind ?? null,
        updatedAt: rows.get('codex')?.updated_at ?? null,
      },
      opencode: {
        set: rows.has('opencode'),
        updatedAt: rows.get('opencode')?.updated_at ?? null,
      },
      github: {
        connected: rows.has('github'),
        login: github.login ?? null,
        method: github.method ?? null,
        updatedAt: rows.get('github')?.updated_at ?? null,
        connectAvailable: this.github.app !== undefined,
      },
    };
  }

  async putHarness(
    owner: string,
    harness: Harness,
    value: string,
    kind: CodexCredentialKind | undefined,
  ): Promise<void> {
    const meta: HarnessMeta = {};
    if (harness === 'codex') {
      if (!kind)
        throw new InputError("codex needs kind 'api_key' or 'auth_json'");
      if (kind === 'auth_json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new InputError(
            'auth_json must be the JSON of a ChatGPT auth.json',
          );
        }
        if (typeof parsed !== 'object' || parsed === null) {
          throw new InputError('auth_json must be a JSON object');
        }
      }
      meta.kind = kind;
    }
    await this.write(owner, harness, value, meta);
  }

  async putGithubToken(owner: string, token: string): Promise<string> {
    let login: string;
    try {
      login = await this.github.getLogin(token);
    } catch (error) {
      throw new InputError(
        `GitHub token rejected: ${(error as Error).message}`,
      );
    }
    await this.writeGithub(
      owner,
      {
        method: 'token',
        accessToken: token,
        accessTokenExpiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      },
      login,
    );
    return login;
  }

  async putGithubOauth(owner: string, tokens: GithubTokens): Promise<string> {
    const login = await this.github.getLogin(tokens.accessToken);
    await this.writeGithub(owner, { method: 'oauth', ...tokens }, login);
    return login;
  }

  async delete(owner: string, name: CredentialName): Promise<void> {
    await this.store.deleteCredential(owner, name);
    this.logger.info(`Deleted the ${name} credential of ${owner}`);
  }

  /** The harness credential and a GitHub token for one run. */
  async forRun(owner: string, harness: Harness): Promise<RunCredentials> {
    const row = await this.store.getCredential(owner, harness);
    if (!row) throw new MissingCredentialError(harness, harness);
    const value = this.cipher.open(row.sealed, this.aad(owner, harness));
    const material = HARNESS_CREDENTIAL[harness](
      value,
      JSON.parse(row.meta) as HarnessMeta,
    );
    const ghToken = await this.githubTokenForRun(owner, harness);
    return { ...material, env: { ...material.env, GH_TOKEN: ghToken } };
  }

  /**
   * A GitHub App user token lasts 8 hours, so each run starts with a fresh one
   * from the stored refresh token. A pasted token is used as is.
   */
  private async githubTokenForRun(
    owner: string,
    harness: Harness,
  ): Promise<string> {
    const row = await this.store.getCredential(owner, 'github');
    if (!row) throw new MissingCredentialError(harness, 'github');
    const stored = JSON.parse(
      this.cipher.open(row.sealed, this.aad(owner, 'github')),
    ) as StoredGithub;
    if (stored.method === 'token' || !stored.refreshToken || !this.github.app) {
      return stored.accessToken;
    }
    try {
      const refreshed = await this.github.refresh(stored.refreshToken);
      const meta = JSON.parse(row.meta) as GithubMeta;
      await this.writeGithub(
        owner,
        { method: 'oauth', ...refreshed },
        meta.login,
      );
      return refreshed.accessToken;
    } catch (error) {
      const expires = stored.accessTokenExpiresAt
        ? Date.parse(stored.accessTokenExpiresAt)
        : Infinity;
      this.logger.warn(
        `Could not refresh the GitHub token of ${owner}: ${
          (error as Error).message
        }`,
      );
      if (expires - Date.now() > GITHUB_MIN_LIFETIME_MS) {
        return stored.accessToken;
      }
      throw new MissingCredentialError(harness, 'github');
    }
  }

  private async writeGithub(
    owner: string,
    stored: StoredGithub,
    login: string,
  ): Promise<void> {
    const meta: GithubMeta = { login, method: stored.method };
    await this.write(owner, 'github', JSON.stringify(stored), meta);
  }

  private async write(
    owner: string,
    name: CredentialName,
    value: string,
    meta: object,
  ): Promise<void> {
    await this.store.putCredential({
      owner_ref: owner,
      name,
      sealed: this.cipher.seal(value, this.aad(owner, name)),
      meta: JSON.stringify(meta),
      updated_at: nowIso(),
    });
    this.logger.info(`Stored the ${name} credential of ${owner}`);
  }
}
