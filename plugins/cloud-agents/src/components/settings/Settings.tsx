import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Button,
  ButtonIcon,
  PasswordField,
  Skeleton,
  TextAreaField,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@backstage/ui';
import { useApi } from '@backstage/frontend-plugin-api';
import {
  RiAddLine,
  RiAlertLine,
  RiArrowRightSLine,
  RiCheckboxCircleLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiGithubLine,
  RiKeyLine,
  RiLockLine,
  RiRefreshLine,
} from '@remixicon/react';
import type {
  AccessToken,
  CodexCredentialKind,
  CreatedAccessToken,
  CredentialName,
  CredentialsSummary,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef } from '../../api';
import { ago, shortDate } from '../../format';
import { useLoad, useNotify, useNow, useTiers } from '../../hooks';
import { InlineAlert, StateMessage, ui, useFocusWhen } from '../ui';
import styles from './Settings.module.css';

/** Which row is open: an editor, a confirmation, or nothing. */
type Open =
  | { mode: 'edit'; name: CredentialName }
  | { mode: 'confirm'; name: CredentialName }
  | { mode: 'revoke'; id: string }
  | undefined;

function useSaver(onSaved: (summary: CredentialsSummary) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const run = async (action: () => Promise<CredentialsSummary>) => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await action());
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Status(props: { ok: boolean; children: ReactNode; meta?: ReactNode }) {
  return (
    <div className={styles.status}>
      <span data-tone={props.ok ? 'ok' : 'warn'}>
        {props.ok ? (
          <RiCheckboxCircleLine className={ui.iconXs} aria-hidden="true" />
        ) : (
          <RiAlertLine className={ui.iconXs} aria-hidden="true" />
        )}
        {props.children}
      </span>
      {props.meta && <span>{props.meta}</span>}
    </div>
  );
}

type SecretName = Exclude<CredentialName, 'github'>;

const SECRET_HELP: Record<SecretName, ReactNode> = {
  claude: (
    <>
      The token printed by <span className={ui.mono}>claude setup-token</span>.
      The Assistant also uses it to ask Claude Opus 5.5.
    </>
  ),
  codex: (
    <>
      An OpenAI API key, or the content of a ChatGPT{' '}
      <span className={ui.mono}>~/.codex/auth.json</span>.
    </>
  ),
  opencode: 'An OpenCode Go API key from the OpenCode console.',
  anthropic: (
    <>
      Optional. An API key from{' '}
      <span className={ui.mono}>console.anthropic.com</span>, starting with{' '}
      <span className={ui.mono}>sk-ant-api</span>, used only when no Claude Code
      credential is set. A Claude Code setup-token (
      <span className={ui.mono}>sk-ant-oat</span>) goes in the Claude Code
      credential instead.
    </>
  ),
};

const SECRET_TITLE: Record<SecretName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode Go',
  anthropic: 'Anthropic API key',
};

const SECRET_LETTER: Record<SecretName, string> = {
  claude: 'C',
  codex: 'X',
  opencode: 'O',
  anthropic: 'A',
};

function SecretRow(props: {
  name: SecretName;
  summary: CredentialsSummary;
  open: Open;
  setOpen(open: Open): void;
  onSaved(summary: CredentialsSummary): void;
}) {
  const { name, summary, open, setOpen } = props;
  const api = useApi(cloudAgentsApiRef);
  const notify = useNotify();
  const tiers = useTiers()
    .filter(t => t.harness === name)
    .map(t => t.name);
  const tierText = tiers.length
    ? `the ${tiers.join(', ')} tier${tiers.length > 1 ? 's' : ''}`
    : `the ${name} harness`;
  const impact =
    name === 'anthropic'
      ? {
          unset: summary.claude.set
            ? 'optional, the Assistant uses your Claude Code credential'
            : 'the Assistant needs this or a Claude Code credential to ask Claude Opus 5.5',
          cleared: summary.claude.set
            ? 'The Assistant keeps using your Claude Code credential.'
            : 'The Assistant cannot ask Claude Opus 5.5 until you add a Claude Code credential or this key.',
        }
      : {
          unset: `${tierText} cannot start`,
          cleared: `Agents on ${tierText} will fail to start until you add it again.`,
        };
  const title = SECRET_TITLE[name];
  const credential = summary[name];
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<CodexCredentialKind>(
    name === 'codex' && summary.codex.kind ? summary.codex.kind : 'api_key',
  );
  const saver = useSaver(props.onSaved);
  const editing = open?.mode === 'edit' && open.name === name;
  const confirming = open?.mode === 'confirm' && open.name === name;
  const editRef = useFocusWhen<HTMLFormElement>(editing);
  const confirmRef = useFocusWhen<HTMLDivElement>(confirming);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    const ok = await saver.run(() =>
      api.putCredential(name, {
        value,
        ...(name === 'codex' && { kind }),
      }),
    );
    if (ok) {
      setValue('');
      setOpen(undefined);
      notify({
        title: 'Saved',
        description: `${title} credential stored, encrypted.`,
      });
    }
  };
  const clear = async () => {
    const ok = await saver.run(() => api.deleteCredential(name));
    if (ok) {
      setOpen(undefined);
      notify({
        title: 'Credential cleared',
        description: `${title} credential removed.`,
        status: 'info',
      });
    }
  };

  const kindLabel =
    name === 'codex' && summary.codex.set
      ? ` as ${
          summary.codex.kind === 'auth_json'
            ? 'ChatGPT auth.json'
            : 'OpenAI API key'
        }`
      : '';

  return (
    <div className={styles.row} data-credential={name}>
      <span className={styles.glyph} aria-hidden="true">
        {SECRET_LETTER[name]}
      </span>
      <div className={styles.rowMain}>
        <div className={styles.name}>{title}</div>
        {credential.set ? (
          <Status
            ok
            meta={
              credential.updatedAt &&
              `updated ${shortDate(credential.updatedAt)}`
            }
          >
            Set{kindLabel}
          </Status>
        ) : (
          <Status ok={false} meta={impact.unset}>
            Not set
          </Status>
        )}
      </div>
      {!editing && !confirming && (
        <div className={styles.acts}>
          <Button
            variant="secondary"
            size="small"
            iconStart={
              credential.set ? undefined : <RiAddLine aria-hidden="true" />
            }
            onPress={() => setOpen({ mode: 'edit', name })}
            aria-label={`${credential.set ? 'Replace' : 'Add'} ${title}`}
          >
            {credential.set ? 'Replace' : 'Add'}
          </Button>
          {credential.set && (
            <Button
              variant="tertiary"
              size="small"
              onPress={() => setOpen({ mode: 'confirm', name })}
              aria-label={`Clear ${title}`}
            >
              Clear
            </Button>
          )}
        </div>
      )}
      {editing && (
        <form
          ref={editRef}
          className={styles.edit}
          aria-label={`${title} credential`}
          onSubmit={save}
        >
          {name === 'codex' && (
            <ToggleButtonGroup
              aria-label="Codex credential kind"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[kind]}
              onSelectionChange={keys => {
                const [key] = [...keys];
                if (key) setKind(key as CodexCredentialKind);
              }}
            >
              <ToggleButton id="api_key" size="small">
                OpenAI API key
              </ToggleButton>
              <ToggleButton id="auth_json" size="small">
                ChatGPT auth.json
              </ToggleButton>
            </ToggleButtonGroup>
          )}
          <div className={styles.help}>{SECRET_HELP[name]}</div>
          {name === 'codex' && kind === 'auth_json' ? (
            <TextAreaField
              aria-label={`${title} value`}
              placeholder='{"tokens": {…}}'
              rows={5}
              value={value}
              onChange={setValue}
              spellCheck="false"
              className={styles.json}
            />
          ) : (
            <PasswordField
              aria-label={`${title} value`}
              icon={<RiKeyLine aria-hidden="true" />}
              placeholder="Paste the value. It is never shown again."
              autoComplete="off"
              value={value}
              onChange={setValue}
            />
          )}
          {saver.error && (
            <InlineAlert tone="error">{saver.error.message}</InlineAlert>
          )}
          <div className={styles.line}>
            <Button
              type="submit"
              variant="primary"
              size="small"
              isDisabled={!value.trim()}
              isPending={saver.busy}
            >
              Save
            </Button>
            <Button
              variant="tertiary"
              size="small"
              onPress={() => setOpen(undefined)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {confirming && (
        <div ref={confirmRef} className={styles.edit}>
          <InlineAlert tone="error">
            Clear the {title} credential? {impact.cleared}
          </InlineAlert>
          {saver.error && (
            <InlineAlert tone="error">{saver.error.message}</InlineAlert>
          )}
          <div className={styles.line}>
            <Button
              variant="primary"
              size="small"
              isPending={saver.busy}
              onPress={clear}
            >
              Clear credential
            </Button>
            <Button
              variant="tertiary"
              size="small"
              onPress={() => setOpen(undefined)}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function GithubRow(props: {
  summary: CredentialsSummary;
  open: Open;
  setOpen(open: Open): void;
  onSaved(summary: CredentialsSummary): void;
}) {
  const { summary, open, setOpen } = props;
  const github = summary.github;
  const api = useApi(cloudAgentsApiRef);
  const notify = useNotify();
  const saver = useSaver(props.onSaved);
  const [value, setValue] = useState('');
  const [connectError, setConnectError] = useState<Error>();
  const editing = open?.mode === 'edit' && open.name === 'github';
  const confirming = open?.mode === 'confirm' && open.name === 'github';
  const editRef = useFocusWhen<HTMLFormElement>(editing);
  const confirmRef = useFocusWhen<HTMLDivElement>(confirming);

  const connect = async () => {
    try {
      window.location.assign(await api.githubConnectUrl());
    } catch (e) {
      setConnectError(e as Error);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    if (await saver.run(() => api.putCredential('github', { value }))) {
      setValue('');
      setOpen(undefined);
      notify({
        title: 'Saved',
        description: 'GitHub token checked and stored.',
      });
    }
  };
  const disconnect = async () => {
    if (await saver.run(() => api.deleteCredential('github'))) {
      setOpen(undefined);
      notify({
        title: 'GitHub disconnected',
        description: 'Connect again before starting an agent.',
        status: 'info',
      });
    }
  };

  return (
    <div className={styles.row} data-credential="github">
      <span className={styles.glyph} aria-hidden="true">
        <RiGithubLine className={ui.icon} />
      </span>
      <div className={styles.rowMain}>
        <div className={styles.name}>
          {github.connected ? `Connected as ${github.login}` : 'Not connected'}
        </div>
        {github.connected ? (
          <Status
            ok
            meta={github.updatedAt && `updated ${shortDate(github.updatedAt)}`}
          >
            {github.method === 'oauth'
              ? 'GitHub App, token refreshes on its own'
              : 'Personal token, never refreshed'}
          </Status>
        ) : (
          <Status ok={false}>Every agent fails to start</Status>
        )}
      </div>
      {!confirming && (
        <div className={styles.acts}>
          {github.connectAvailable && (
            <Button
              variant={github.connected ? 'secondary' : 'primary'}
              size="small"
              iconStart={<RiGithubLine aria-hidden="true" />}
              onPress={connect}
            >
              {github.connected ? 'Reconnect' : 'Connect with GitHub'}
            </Button>
          )}
          {github.connected && (
            <Button
              variant="tertiary"
              size="small"
              onPress={() => setOpen({ mode: 'confirm', name: 'github' })}
            >
              Disconnect
            </Button>
          )}
        </div>
      )}
      {connectError && (
        <div className={styles.edit}>
          <InlineAlert tone="error">{connectError.message}</InlineAlert>
        </div>
      )}
      {confirming && (
        <div ref={confirmRef} className={styles.edit}>
          <InlineAlert tone="error">
            Disconnect GitHub? Running agents keep their current token until
            they finish. New agents cannot start.
          </InlineAlert>
          {saver.error && (
            <InlineAlert tone="error">{saver.error.message}</InlineAlert>
          )}
          <div className={styles.line}>
            <Button
              variant="primary"
              size="small"
              isPending={saver.busy}
              onPress={disconnect}
            >
              Disconnect GitHub
            </Button>
            <Button
              variant="tertiary"
              size="small"
              onPress={() => setOpen(undefined)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {editing ? (
        <form
          ref={editRef}
          className={styles.edit}
          aria-label="GitHub credential"
          onSubmit={save}
        >
          <div className={styles.help}>
            A personal access token that can push to your repositories.
            Backstage checks it with <span className={ui.mono}>GET /user</span>.
          </div>
          <PasswordField
            aria-label="GitHub value"
            icon={<RiKeyLine aria-hidden="true" />}
            placeholder="github_pat_…"
            autoComplete="off"
            value={value}
            onChange={setValue}
          />
          {saver.error && (
            <InlineAlert tone="error">{saver.error.message}</InlineAlert>
          )}
          <div className={styles.line}>
            <Button
              type="submit"
              variant="primary"
              size="small"
              isDisabled={!value.trim()}
              isPending={saver.busy}
            >
              Save token
            </Button>
            <Button
              variant="tertiary"
              size="small"
              onPress={() => setOpen(undefined)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        !confirming && (
          <div className={styles.edit} data-quiet="">
            <button
              type="button"
              className={styles.disclosure}
              onClick={() => setOpen({ mode: 'edit', name: 'github' })}
            >
              <RiArrowRightSLine className={ui.iconXs} aria-hidden="true" />
              Use a token instead
            </button>
          </div>
        )
      )}
    </div>
  );
}

function TokenRow(props: {
  token: AccessToken;
  now: number;
  confirming: boolean;
  onAsk(): void;
  onCancel(): void;
  onRevoke(): void;
}) {
  const { token, confirming } = props;
  const actsRef = useFocusWhen<HTMLDivElement>(confirming);
  return (
    <div className={styles.row}>
      <span className={styles.glyph} aria-hidden="true">
        <RiKeyLine className={ui.icon} />
      </span>
      <div className={styles.rowMain}>
        <div className={styles.name}>{token.name}</div>
        <div className={styles.status}>
          <span>created {shortDate(token.createdAt)}</span>
          <span>
            {token.lastUsedAt
              ? `last used ${ago(token.lastUsedAt, props.now)}`
              : 'never used'}
          </span>
        </div>
      </div>
      <div ref={actsRef} className={styles.acts}>
        {confirming ? (
          <>
            <Button variant="primary" size="small" onPress={props.onRevoke}>
              Revoke
            </Button>
            <Button variant="tertiary" size="small" onPress={props.onCancel}>
              Cancel
            </Button>
          </>
        ) : (
          <ButtonIcon
            variant="tertiary"
            aria-label={`Revoke token ${token.name}`}
            icon={<RiDeleteBinLine />}
            onPress={props.onAsk}
          />
        )}
      </div>
    </div>
  );
}

function Tokens(props: { open: Open; setOpen(open: Open): void }) {
  const api = useApi(cloudAgentsApiRef);
  const notify = useNotify();
  const now = useNow(30_000);
  const tokens = useLoad(() => api.listTokens(), [api]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedAccessToken>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setCreated(await api.createToken(name.trim()));
      setCopied(false);
      setName('');
      tokens.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (token: AccessToken) => {
    try {
      await api.deleteToken(token.id);
      if (created?.id === token.id) setCreated(undefined);
      props.setOpen(undefined);
      tokens.reload();
      notify({
        title: 'Token revoked',
        description: 'Clients using it get 401 from now on.',
        status: 'info',
      });
    } catch (e) {
      setError(e as Error);
    }
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      notify({
        title: 'Could not copy',
        description: 'Select the token and copy it by hand.',
        status: 'warning',
      });
    }
  };

  return (
    <div className={`${ui.card} ${styles.list}`}>
      <form
        className={styles.tokenForm}
        aria-label="New token"
        onSubmit={create}
      >
        <TextField
          aria-label="Token name"
          icon={<RiKeyLine aria-hidden="true" />}
          placeholder="Name, such as T3 bridge on my laptop"
          value={name}
          onChange={setName}
          className={styles.grow}
        />
        <Button
          type="submit"
          variant="primary"
          size="small"
          iconStart={<RiAddLine aria-hidden="true" />}
          isDisabled={!name.trim()}
          isPending={busy}
        >
          Create token
        </Button>
        {created && (
          <div className={styles.reveal} role="status">
            <p>
              <b>Copy this token now.</b> Backstage stores only its hash, so it
              is never shown again.
            </p>
            <div className={styles.tok}>
              <span data-testid="new-token">{created.token}</span>
              <Button
                variant="secondary"
                size="small"
                iconStart={
                  copied ? (
                    <RiCheckLine aria-hidden="true" />
                  ) : (
                    <RiFileCopyLine aria-hidden="true" />
                  )
                }
                onPress={copy}
                className={copied ? styles.copied : undefined}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div>
              <Button
                variant="tertiary"
                size="small"
                onPress={() => setCreated(undefined)}
              >
                I copied it
              </Button>
            </div>
          </div>
        )}
        {error && (
          <div className={styles.full}>
            <InlineAlert tone="error">{error.message}</InlineAlert>
          </div>
        )}
      </form>
      {!tokens.value && tokens.loading && (
        <div className={styles.row} aria-busy="true">
          <Skeleton width={40} height={40} />
          <Skeleton width="40%" height={13} />
        </div>
      )}
      {tokens.value?.length === 0 && (
        <p className={styles.none}>
          No tokens. Create one for each client, so you can revoke them one by
          one.
        </p>
      )}
      {(tokens.value ?? []).map(token => (
        <TokenRow
          key={token.id}
          token={token}
          now={now}
          confirming={
            props.open?.mode === 'revoke' && props.open.id === token.id
          }
          onAsk={() => props.setOpen({ mode: 'revoke', id: token.id })}
          onCancel={() => props.setOpen(undefined)}
          onRevoke={() => revoke(token)}
        />
      ))}
    </div>
  );
}

export function Settings() {
  const api = useApi(cloudAgentsApiRef);
  const location = useLocation();
  const loaded = useLoad(() => api.getCredentials(), [api]);
  const [summary, setSummary] = useState<CredentialsSummary>();
  const [open, setOpen] = useState<Open>();
  const current = summary ?? loaded.value;
  const result = new URLSearchParams(location.search).get('github');

  if (!current && loaded.error) {
    return (
      <StateMessage
        icon={RiAlertLine}
        tone="error"
        role="alert"
        title="Could not load your credentials"
        action={
          <Button
            variant="secondary"
            iconStart={<RiRefreshLine aria-hidden="true" />}
            onPress={loaded.reload}
          >
            Try again
          </Button>
        }
      >
        {loaded.error.message}
      </StateMessage>
    );
  }

  return (
    <section className={styles.settings} aria-label="Settings">
      {result === 'connected' && (
        <InlineAlert tone="ok">
          GitHub connected
          {current?.github.login ? ` as ${current.github.login}` : ''}.
        </InlineAlert>
      )}
      {(result === 'failed' || result === 'denied') && (
        <InlineAlert tone="error">GitHub authorization {result}.</InlineAlert>
      )}
      <div className={styles.intro}>
        <RiLockLine className={ui.icon} aria-hidden="true" />
        <span>
          Each run receives only the credential its harness needs plus your
          GitHub token, in a Kubernetes Secret deleted with the run. Values are
          encrypted at rest and never shown again.
        </span>
      </div>
      <section className={styles.sec} aria-labelledby="set-github">
        <h2 id="set-github">GitHub</h2>
        <p>Agents clone, push and open pull requests as you.</p>
        <div className={`${ui.card} ${styles.list}`}>
          {current ? (
            <GithubRow
              summary={current}
              open={open}
              setOpen={setOpen}
              onSaved={setSummary}
            />
          ) : (
            <SkeletonRow />
          )}
        </div>
      </section>
      <section className={styles.sec} aria-labelledby="set-harness">
        <h2 id="set-harness">Harness credentials</h2>
        <p>One per harness. The tier you pick decides which one a run uses.</p>
        <div className={`${ui.card} ${styles.list}`}>
          {current
            ? (['claude', 'codex', 'opencode'] as const).map(name => (
                <SecretRow
                  key={name}
                  name={name}
                  summary={current}
                  open={open}
                  setOpen={setOpen}
                  onSaved={setSummary}
                />
              ))
            : [0, 1, 2].map(i => <SkeletonRow key={i} />)}
        </div>
      </section>
      <section className={styles.sec} aria-labelledby="set-assistant">
        <h2 id="set-assistant">Assistant</h2>
        <p>
          The Assistant's reasoning tool runs Claude Opus 5.5 through Claude
          Code with your Claude Code credential above. Without one, it uses this
          Anthropic API key. No agent run uses the key.
        </p>
        <div className={`${ui.card} ${styles.list}`}>
          {current ? (
            <SecretRow
              name="anthropic"
              summary={current}
              open={open}
              setOpen={setOpen}
              onSaved={setSummary}
            />
          ) : (
            <SkeletonRow />
          )}
        </div>
      </section>
      <section className={styles.sec} aria-labelledby="set-tokens">
        <h2 id="set-tokens">Personal access tokens</h2>
        <p>
          For external clients such as the T3 bridge. They send{' '}
          <span className={ui.mono}>Authorization: Bearer cat_…</span> and act
          as you.
        </p>
        <Tokens open={open} setOpen={setOpen} />
      </section>
    </section>
  );
}

function SkeletonRow() {
  return (
    <div className={styles.row} aria-busy="true" aria-label="Loading">
      <Skeleton width={40} height={40} />
      <div>
        <Skeleton width="45%" height={13} />
        <Skeleton width="30%" height={10} style={{ marginTop: 8 }} />
      </div>
    </div>
  );
}
