import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Button,
  FormControlLabel,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemSecondaryAction,
  ListItemText,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/Delete';
import Alert from '@material-ui/lab/Alert';
import { ErrorPanel, InfoCard, Progress } from '@backstage/core-components';
import { useApi } from '@backstage/frontend-plugin-api';
import type {
  CodexCredentialKind,
  CreatedAccessToken,
  CredentialName,
  CredentialsSummary,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef } from '../api';
import { useLoad } from '../hooks';

function when(iso: string | null): string {
  return iso ? `, updated ${new Date(iso).toLocaleString()}` : '';
}

/** One credential: whether it is set, a write-only field to set it, and Clear. */
function CredentialCard(props: {
  name: CredentialName;
  title: string;
  help: ReactNode;
  set: boolean;
  status: string;
  multiline?: boolean;
  extra?: ReactNode;
  kind?: CodexCredentialKind;
  onSaved(summary: CredentialsSummary): void;
}) {
  const api = useApi(cloudAgentsApiRef);
  const [value, setValue] = useState('');
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<CredentialsSummary>) => {
    setBusy(true);
    setError(undefined);
    try {
      props.onSaved(await action());
      setValue('');
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    run(() =>
      api.putCredential(props.name, {
        value,
        ...(props.kind && { kind: props.kind }),
      }),
    );
  };

  return (
    <InfoCard title={props.title} subheader={props.status}>
      <form onSubmit={save} aria-label={`${props.title} credential`}>
        <Typography variant="body2" paragraph>
          {props.help}
        </Typography>
        {props.extra}
        <TextField
          id={`credential-${props.name}`}
          label={props.set ? 'Replace value' : 'Value'}
          type={props.multiline ? 'text' : 'password'}
          autoComplete="off"
          fullWidth
          multiline={props.multiline}
          minRows={props.multiline ? 4 : undefined}
          value={value}
          onChange={e => setValue(e.target.value)}
          inputProps={{ 'aria-label': `${props.title} value` }}
        />
        {error && <Alert severity="error">{error.message}</Alert>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={busy || !value.trim()}
          >
            Save
          </Button>
          <Button
            variant="outlined"
            disabled={busy || !props.set}
            onClick={() => run(() => api.deleteCredential(props.name))}
          >
            Clear
          </Button>
        </div>
      </form>
    </InfoCard>
  );
}

function GithubCard(props: {
  summary: CredentialsSummary['github'];
  onSaved(s: CredentialsSummary): void;
}) {
  const api = useApi(cloudAgentsApiRef);
  const location = useLocation();
  const [error, setError] = useState<Error>();
  const result = new URLSearchParams(location.search).get('github');
  const connect = async () => {
    try {
      window.location.assign(await api.githubConnectUrl());
    } catch (e) {
      setError(e as Error);
    }
  };
  const status = props.summary.connected
    ? `Connected as ${props.summary.login} with ${
        props.summary.method === 'oauth' ? 'the GitHub App' : 'a token'
      }${when(props.summary.updatedAt)}`
    : 'Not connected';
  return (
    <CredentialCard
      name="github"
      title="GitHub"
      set={props.summary.connected}
      status={status}
      onSaved={props.onSaved}
      help="Agents clone, push, and open pull requests as you. Connect through the GitHub App, or paste a token that can push to your repositories."
      extra={
        <>
          {result === 'connected' && (
            <Alert severity="success">GitHub connected.</Alert>
          )}
          {(result === 'failed' || result === 'denied') && (
            <Alert severity="error">GitHub authorization {result}.</Alert>
          )}
          {error && <Alert severity="error">{error.message}</Alert>}
          {props.summary.connectAvailable && (
            <Button
              variant="contained"
              color="primary"
              onClick={connect}
              style={{ marginBottom: 8 }}
            >
              {props.summary.connected
                ? 'Reconnect with GitHub'
                : 'Connect with GitHub'}
            </Button>
          )}
        </>
      }
    />
  );
}

function TokensCard() {
  const api = useApi(cloudAgentsApiRef);
  const tokens = useLoad(() => api.listTokens(), [api]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedAccessToken>();
  const [error, setError] = useState<Error>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setCreated(await api.createToken(name));
      setName('');
      tokens.reload();
    } catch (e) {
      setError(e as Error);
    }
  };
  const remove = async (id: string) => {
    try {
      await api.deleteToken(id);
      if (created?.id === id) setCreated(undefined);
      tokens.reload();
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <InfoCard
      title="Personal access tokens"
      subheader="For external clients such as the T3 bridge: Authorization: Bearer cat_…"
    >
      <form
        onSubmit={create}
        aria-label="New token"
        style={{ display: 'flex', gap: 8 }}
      >
        <TextField
          id="token-name"
          label="Token name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={!name.trim()}
        >
          Create token
        </Button>
      </form>
      {created && (
        <Alert severity="info" style={{ marginTop: 8 }}>
          Copy this token now. It is not shown again:{' '}
          <code data-testid="new-token">{created.token}</code>
        </Alert>
      )}
      {error && <Alert severity="error">{error.message}</Alert>}
      <List dense>
        {(tokens.value ?? []).map(token => (
          <ListItem key={token.id}>
            <ListItemText
              primary={token.name}
              secondary={`Created ${new Date(
                token.createdAt,
              ).toLocaleString()}${
                token.lastUsedAt
                  ? `, last used ${new Date(token.lastUsedAt).toLocaleString()}`
                  : ', never used'
              }`}
            />
            <ListItemSecondaryAction>
              <IconButton
                edge="end"
                aria-label={`Delete token ${token.name}`}
                onClick={() => remove(token.id)}
              >
                <DeleteIcon />
              </IconButton>
            </ListItemSecondaryAction>
          </ListItem>
        ))}
      </List>
    </InfoCard>
  );
}

export function Settings() {
  const api = useApi(cloudAgentsApiRef);
  const loaded = useLoad(() => api.getCredentials(), [api]);
  const [summary, setSummary] = useState<CredentialsSummary>();
  const [codexKind, setCodexKind] = useState<CodexCredentialKind>('api_key');
  const current = summary ?? loaded.value;

  if (loaded.error) return <ErrorPanel error={loaded.error} />;
  if (!current) return <Progress />;

  return (
    <Grid container spacing={3}>
      <Grid item xs={12}>
        <Typography variant="body1">
          Each run receives only the credential its harness needs and your
          GitHub token, in a Kubernetes Secret deleted with the run. Values are
          stored encrypted and never shown again.
        </Typography>
      </Grid>
      <Grid item xs={12} md={6}>
        <CredentialCard
          name="claude"
          title="Claude Code"
          set={current.claude.set}
          status={
            current.claude.set
              ? `Set${when(current.claude.updatedAt)}`
              : 'Not set'
          }
          help={
            <>
              The token printed by <code>claude setup-token</code>.
            </>
          }
          onSaved={setSummary}
        />
      </Grid>
      <Grid item xs={12} md={6}>
        <CredentialCard
          name="codex"
          title="Codex"
          set={current.codex.set}
          status={
            current.codex.set
              ? `Set as ${
                  current.codex.kind === 'auth_json'
                    ? 'ChatGPT auth.json'
                    : 'OpenAI API key'
                }${when(current.codex.updatedAt)}`
              : 'Not set'
          }
          help="An OpenAI API key, or the content of a ChatGPT ~/.codex/auth.json."
          kind={codexKind}
          multiline={codexKind === 'auth_json'}
          extra={
            <RadioGroup
              row
              aria-label="Codex credential kind"
              value={codexKind}
              onChange={e =>
                setCodexKind(e.target.value as CodexCredentialKind)
              }
            >
              <FormControlLabel
                value="api_key"
                control={<Radio />}
                label="API key"
              />
              <FormControlLabel
                value="auth_json"
                control={<Radio />}
                label="auth.json"
              />
            </RadioGroup>
          }
          onSaved={setSummary}
        />
      </Grid>
      <Grid item xs={12} md={6}>
        <CredentialCard
          name="opencode"
          title="OpenCode Go"
          set={current.opencode.set}
          status={
            current.opencode.set
              ? `Set${when(current.opencode.updatedAt)}`
              : 'Not set'
          }
          help="An OpenCode Go API key from the OpenCode console."
          onSaved={setSummary}
        />
      </Grid>
      <Grid item xs={12} md={6}>
        <GithubCard summary={current.github} onSaved={setSummary} />
      </Grid>
      <Grid item xs={12}>
        <TokensCard />
      </Grid>
    </Grid>
  );
}
