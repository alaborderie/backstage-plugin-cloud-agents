import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
} from '@material-ui/core';
import Alert from '@material-ui/lab/Alert';
import { InfoCard, Link } from '@backstage/core-components';
import { configApiRef, useApi } from '@backstage/frontend-plugin-api';
import {
  DEFAULT_TIERS,
  HARNESSES,
  type CreateAgentRequest,
  type Harness,
  type TierInfo,
} from '@alaborderie/plugin-cloud-agents-common';
import { CloudAgentsApiError, cloudAgentsApiRef } from '../api';
import { useBasePath } from '../hooks';

function useTiers(): TierInfo[] {
  const config = useApi(configApiRef);
  return useMemo(() => {
    const tiers = config.getOptionalConfig('cloudAgents.tiers');
    if (!tiers) return [...DEFAULT_TIERS];
    return tiers.keys().map(name => {
      const tier = tiers.getConfig(name);
      return {
        name,
        harness: tier.getString('harness') as Harness,
        model: tier.getString('model'),
        effort: tier.getOptionalString('effort') ?? 'high',
      };
    });
  }, [config]);
}

export function NewAgent() {
  const api = useApi(cloudAgentsApiRef);
  const navigate = useNavigate();
  const base = useBasePath();
  const tiers = useTiers();
  const [form, setForm] = useState({
    repo: '',
    base: 'main',
    branch: '',
    title: '',
    prompt: '',
    mode: 'tier' as 'tier' | 'custom',
    tier: tiers[0]?.name ?? '',
    harness: 'opencode' as Harness,
    model: '',
    effort: 'high',
  });
  const [error, setError] = useState<CloudAgentsApiError | Error>();
  const [submitting, setSubmitting] = useState(false);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm(f => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const request: CreateAgentRequest = {
      repo: form.repo.trim(),
      base: form.base.trim() || 'main',
      prompt: form.prompt,
      ...(form.branch.trim() && { branch: form.branch.trim() }),
      ...(form.title.trim() && { title: form.title.trim() }),
      ...(form.mode === 'tier'
        ? { tier: form.tier }
        : {
            harness: form.harness,
            model: form.model.trim(),
            effort: form.effort.trim() || 'high',
          }),
    };
    try {
      const agent = await api.createAgent(request);
      navigate(`${base}/agents/${agent.id}`);
    } catch (e) {
      setError(e as Error);
      setSubmitting(false);
    }
  };

  const missing =
    error instanceof CloudAgentsApiError ? error.missingCredential : undefined;

  return (
    <InfoCard title="New agent">
      <form onSubmit={submit} aria-label="New agent">
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <TextField
              id="new-agent-repo"
              label="Repository"
              placeholder="owner/name"
              required
              fullWidth
              value={form.repo}
              onChange={e => set('repo')(e.target.value)}
            />
          </Grid>
          <Grid item xs={6} md={3}>
            <TextField
              id="new-agent-base"
              label="Base"
              fullWidth
              value={form.base}
              onChange={e => set('base')(e.target.value)}
            />
          </Grid>
          <Grid item xs={6} md={3}>
            <TextField
              id="new-agent-branch"
              label="Branch"
              placeholder="cloud-agent/<id>"
              fullWidth
              value={form.branch}
              onChange={e => set('branch')(e.target.value)}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              id="new-agent-title"
              label="Title"
              fullWidth
              value={form.title}
              onChange={e => set('title')(e.target.value)}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              id="new-agent-prompt"
              label="Prompt"
              required
              fullWidth
              multiline
              minRows={6}
              variant="outlined"
              value={form.prompt}
              onChange={e => set('prompt')(e.target.value)}
            />
          </Grid>
          <Grid item xs={12}>
            <RadioGroup
              row
              aria-label="Model choice"
              value={form.mode}
              onChange={e => set('mode')(e.target.value)}
            >
              <FormControlLabel value="tier" control={<Radio />} label="Tier" />
              <FormControlLabel
                value="custom"
                control={<Radio />}
                label="Harness and model"
              />
            </RadioGroup>
          </Grid>
          {form.mode === 'tier' ? (
            <Grid item xs={12} md={6}>
              <FormControl fullWidth>
                <InputLabel id="tier-label">Tier</InputLabel>
                <Select
                  labelId="tier-label"
                  value={form.tier}
                  onChange={e => set('tier')(e.target.value as string)}
                >
                  {tiers.map(t => (
                    <MenuItem key={t.name} value={t.name}>
                      {t.name} · {t.harness} {t.model} ({t.effort})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
          ) : (
            <>
              <Grid item xs={12} md={3}>
                <FormControl fullWidth>
                  <InputLabel id="harness-label">Harness</InputLabel>
                  <Select
                    labelId="harness-label"
                    value={form.harness}
                    onChange={e => set('harness')(e.target.value as string)}
                  >
                    {HARNESSES.map(h => (
                      <MenuItem key={h} value={h}>
                        {h}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  id="new-agent-model"
                  label="Model"
                  required
                  fullWidth
                  value={form.model}
                  onChange={e => set('model')(e.target.value)}
                />
              </Grid>
              <Grid item xs={12} md={3}>
                <TextField
                  id="new-agent-effort"
                  label="Effort"
                  fullWidth
                  value={form.effort}
                  onChange={e => set('effort')(e.target.value)}
                />
              </Grid>
            </>
          )}
          {error && (
            <Grid item xs={12}>
              <Alert severity="error">
                {missing ? (
                  <>
                    Set your {missing} credential in{' '}
                    <Link to={`${base}/settings`}>settings</Link> first.
                  </>
                ) : (
                  error.message
                )}
              </Alert>
            </Grid>
          )}
          <Grid item xs={12}>
            <Button
              type="submit"
              variant="contained"
              color="primary"
              disabled={submitting}
            >
              Start agent
            </Button>
          </Grid>
        </Grid>
      </form>
    </InfoCard>
  );
}
