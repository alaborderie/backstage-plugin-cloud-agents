import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  ButtonIcon,
  Checkbox,
  Combobox,
  Radio,
  RadioGroup,
  Select,
  TextAreaField,
  TextField,
} from '@backstage/ui';
import { useApi } from '@backstage/frontend-plugin-api';
import {
  RiAlertLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiGitBranchLine,
  RiGithubLine,
  RiKeyLine,
  RiNodeTree,
  RiRecordCircleLine,
  RiRobot2Line,
  RiSparkling2Line,
} from '@remixicon/react';
import {
  HARNESSES,
  type AgentKind,
  type CreateAgentRequest,
  type CredentialsSummary,
  type Harness,
  type TierInfo,
} from '@alaborderie/plugin-cloud-agents-common';
import { CloudAgentsApiError, cloudAgentsApiRef } from '../../api';
import { useAgents, useBasePath, useLoad, useTiers } from '../../hooks';
import { InlineAlert, Kbd, tierIcon, ui, type Icon } from '../ui';
import styles from './NewAgent.module.css';

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

/** One line on when to pick each default tier. Other tiers show their model. */
const TIER_HINT: Record<string, string> = {
  flash: 'Fast and cheap. Small fixes, chores, follow-ups.',
  sol: 'Balanced. Most features and bug fixes.',
  opus: 'Strongest judgment. Design work, gnarly refactors.',
};

const HARNESS_LABEL: Record<Harness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode Go',
};

/** What each kind asks for and does, worded for the form. */
const KIND: Record<
  AgentKind,
  {
    name: string;
    icon: Icon;
    hint: string;
    prompt: string;
    description: string;
    placeholder: string;
    empty: string;
  }
> = {
  task: {
    name: 'Agent',
    icon: RiRobot2Line,
    hint: 'Does the work on one branch and opens a pull request.',
    prompt: 'What should the agent do?',
    description:
      'The agent receives this brief verbatim, plus your skills. Blocking questions come back to you here.',
    placeholder:
      'Describe the change, the constraints, and how you will judge it done.',
    empty: 'Write a prompt first.',
  },
  hub: {
    name: 'Hub',
    icon: RiNodeTree,
    hint: 'Splits an objective into tasks, starts an agent for each, and finishes when they are all done.',
    prompt: 'What is the hub’s objective?',
    description:
      'The hub splits it into tasks, starts one child agent per task, and follows them. Blocking questions come back to you here.',
    placeholder:
      'Describe the outcome, the constraints, and how you will judge it done.',
    empty: 'Write the objective first.',
  },
};

interface FromIssue {
  repo: string;
  number: string;
  title: string;
  url: string;
}

/**
 * The hand-to-agent deep link:
 * `/cloud-agents/new?repo=<owner>/<name>&issue=<number>&title=<title>`.
 */
export function issueFromSearch(search: string): FromIssue | undefined {
  const params = new URLSearchParams(search);
  const repo = params.get('repo')?.trim() ?? '';
  const number = params.get('issue')?.trim() ?? '';
  if (!REPO_PATTERN.test(repo) || !/^\d+$/.test(number)) return undefined;
  return {
    repo,
    number,
    title: params.get('title')?.trim() ?? '',
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

export function prefillFromSearch(search: string) {
  const params = new URLSearchParams(search);
  const repo = params.get('repo')?.trim() ?? '';
  const issue = issueFromSearch(search);
  return {
    repo: REPO_PATTERN.test(repo) ? repo : '',
    title: issue?.title ?? params.get('title')?.trim() ?? '',
    prompt: issue ? issuePrompt(issue) : params.get('prompt') ?? '',
  };
}

export function issuePrompt(issue: FromIssue): string {
  return `Resolve ${issue.url}${issue.title ? `: ${issue.title}` : ''}

Read the issue and its comments first. Open a pull request that closes #${
    issue.number
  }, and ask me before any choice the issue leaves open.`;
}

interface Form {
  kind: AgentKind;
  prompt: string;
  repo: string;
  tier: string;
  title: string;
  base: string;
  branch: string;
  custom: boolean;
  harness: Harness;
  model: string;
  effort: string;
}

/** Whether a harness can start a run with the user's stored credentials. */
function missingFor(
  harness: Harness,
  credentials: CredentialsSummary | undefined,
): 'github' | Harness | undefined {
  if (!credentials) return undefined;
  if (!credentials[harness].set) return harness;
  if (!credentials.github.connected) return 'github';
  return undefined;
}

function runsOn(form: Form, tier: TierInfo | undefined): string {
  if (form.custom) return `${form.harness} · ${form.model.trim() || '?'}`;
  return tier ? `${tier.name} · ${tier.harness}` : '?';
}

function TierCard(props: {
  tier: TierInfo;
  credentials: CredentialsSummary | undefined;
}) {
  const { tier, credentials } = props;
  const Icon = tierIcon(tier.name);
  const set = credentials?.[tier.harness].set;
  return (
    <Radio value={tier.name} className={styles.tierCard}>
      <span className={styles.tTop}>
        <span className={styles.tGlyph}>
          <Icon className={ui.icon} aria-hidden="true" />
        </span>
        <b>{tier.name.charAt(0).toUpperCase() + tier.name.slice(1)}</b>
      </span>
      <span className={styles.model}>
        {tier.harness} · {tier.model.split('/').pop()}
      </span>
      <span className={styles.desc}>
        {TIER_HINT[tier.name] ?? `Effort ${tier.effort}.`}
      </span>
      {set !== undefined && (
        <span className={styles.cred} data-missing={set ? undefined : ''}>
          {set ? (
            <RiCheckLine className={ui.iconXs} aria-hidden="true" />
          ) : (
            <RiAlertLine className={ui.iconXs} aria-hidden="true" />
          )}
          {set
            ? `${tier.harness} credential set`
            : `${tier.harness} credential missing`}
        </span>
      )}
    </Radio>
  );
}

export function NewAgent() {
  const api = useApi(cloudAgentsApiRef);
  const navigate = useNavigate();
  const location = useLocation();
  const base = useBasePath();
  const tiers = useTiers();
  const agents = useAgents();
  const credentials = useLoad(() => api.getCredentials(), [api]);
  const issue = useMemo(
    () => issueFromSearch(location.search),
    [location.search],
  );
  const prefill = useMemo(
    () => prefillFromSearch(location.search),
    [location.search],
  );
  const [showIssue, setShowIssue] = useState(Boolean(issue));
  const [form, setForm] = useState<Form>(() => ({
    kind: 'task',
    prompt: prefill.prompt,
    repo: prefill.repo,
    tier: tiers[0]?.name ?? '',
    title: prefill.title,
    base: 'main',
    branch: '',
    custom: false,
    harness: 'opencode',
    model: '',
    effort: 'high',
  }));
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<Error>();
  const [repoError, setRepoError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const advancedId = useId();

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const recentRepos = useMemo(() => {
    const seen = new Set<string>();
    for (const agent of agents.value ?? []) seen.add(agent.repo);
    return [...seen].slice(0, 12);
  }, [agents.value]);

  const [tierTouched, setTierTouched] = useState(false);
  useEffect(() => {
    if (tierTouched || !credentials.value) return;
    const ready = tiers.find(t => !missingFor(t.harness, credentials.value));
    if (ready) setForm(f => ({ ...f, tier: ready.name }));
  }, [credentials.value, tiers, tierTouched]);

  const tier = tiers.find(t => t.name === form.tier);
  const harness = form.custom ? form.harness : tier?.harness ?? form.harness;
  const missing = missingFor(harness, credentials.value);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const dropIssue = () => {
    setShowIssue(false);
    setForm(f => ({
      ...f,
      prompt: f.prompt === prefill.prompt ? '' : f.prompt,
      title: f.title === prefill.title ? '' : f.title,
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || missing) return;
    setError(undefined);
    const repo = form.repo.trim();
    if (!REPO_PATTERN.test(repo)) {
      setRepoError(
        repo
          ? `${repo} is not a repository. Write it as owner/name.`
          : 'Choose a repository.',
      );
      return;
    }
    setRepoError(undefined);
    if (!form.prompt.trim()) {
      setError(new Error(KIND[form.kind].empty));
      return;
    }
    if (form.custom && !form.model.trim()) {
      setAdvanced(true);
      setError(new Error('Name the model to run, or pick a tier.'));
      return;
    }
    const request: CreateAgentRequest = {
      kind: form.kind,
      repo,
      base: form.base.trim() || 'main',
      prompt: form.prompt,
      ...(form.branch.trim() && { branch: form.branch.trim() }),
      ...(form.title.trim() && { title: form.title.trim() }),
      ...(form.custom
        ? {
            harness: form.harness,
            model: form.model.trim(),
            effort: form.effort.trim() || 'high',
          }
        : { tier: form.tier }),
    };
    setSubmitting(true);
    try {
      const agent = await api.createAgent(request);
      agents.reload();
      navigate(`${base}/agents/${agent.id}`);
    } catch (e) {
      setError(e as Error);
      setSubmitting(false);
    }
  };

  const serverMissing =
    error instanceof CloudAgentsApiError ? error.missingCredential : undefined;

  return (
    <section aria-labelledby="new-agent-title">
      <h2 id="new-agent-title" className={styles.srOnly}>
        New agent
      </h2>
      <form
        ref={formRef}
        className={styles.grid}
        aria-label="New agent"
        noValidate
        onSubmit={submit}
      >
        <div className={`${ui.card} ${styles.main}`}>
          {issue && showIssue && (
            <div className={styles.fromIssue} role="status">
              <RiRecordCircleLine className={ui.icon} aria-hidden="true" />
              <span>
                From{' '}
                <a href={issue.url} target="_blank" rel="noopener noreferrer">
                  <b>
                    {issue.repo.split('/').pop()} #{issue.number}
                  </b>
                </a>
                {issue.title && ` · ${issue.title}`}
              </span>
              <ButtonIcon
                variant="tertiary"
                size="small"
                aria-label="Start without the issue"
                icon={<RiCloseLine />}
                onPress={dropIssue}
              />
            </div>
          )}
          <RadioGroup
            label="Kind"
            orientation="horizontal"
            value={form.kind}
            onChange={value => set('kind', value as AgentKind)}
            className={styles.kinds}
          >
            {(Object.keys(KIND) as AgentKind[]).map(kind => {
              const { name, icon: KindIcon, hint } = KIND[kind];
              return (
                <Radio key={kind} value={kind} className={styles.tierCard}>
                  <span className={styles.tTop}>
                    <span className={styles.tGlyph}>
                      <KindIcon className={ui.icon} aria-hidden="true" />
                    </span>
                    <b>{name}</b>
                  </span>
                  <span className={styles.desc}>{hint}</span>
                </Radio>
              );
            })}
          </RadioGroup>
          <TextAreaField
            label={KIND[form.kind].prompt}
            description={KIND[form.kind].description}
            placeholder={KIND[form.kind].placeholder}
            rows={8}
            value={form.prompt}
            onChange={value => set('prompt', value)}
            className={styles.prompt}
            isRequired
          />
          <div>
            <Combobox
              label="Repository"
              description={
                repoError
                  ? undefined
                  : 'Recent repositories first. Any owner/name you can push to works.'
              }
              placeholder="owner/name"
              icon={<RiGithubLine aria-hidden="true" />}
              allowsCustomValue
              menuTrigger="input"
              inputValue={form.repo}
              onInputChange={value => {
                set('repo', value);
                setRepoError(undefined);
              }}
              options={recentRepos.map((repo, i) => ({
                id: repo,
                label: repo,
                ...(i < 3 && { description: 'recent' }),
              }))}
              isRequired
              isInvalid={Boolean(repoError)}
            />
            {repoError && (
              <div className={styles.fieldError} role="alert">
                {repoError}
              </div>
            )}
          </div>
          <RadioGroup
            label="Tier"
            value={form.custom ? null : form.tier}
            onChange={value => {
              setTierTouched(true);
              setForm(f => ({ ...f, tier: value, custom: false }));
            }}
            className={styles.tiers}
          >
            {tiers.map(t => (
              <TierCard key={t.name} tier={t} credentials={credentials.value} />
            ))}
          </RadioGroup>
          {missing && (
            <InlineAlert tone="warn">
              {missing === 'github'
                ? 'GitHub is not connected, so this run would fail to start. '
                : `Your ${HARNESS_LABEL[missing]} credential is not set, so this run would fail to start. `}
              <Link to={`${base}/settings`}>Add it in Settings</Link>
              {missing === 'github' ? '.' : ', or pick another tier.'}
            </InlineAlert>
          )}
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={advanced}
            aria-controls={advancedId}
            onClick={() => setAdvanced(a => !a)}
          >
            <RiArrowRightSLine
              className={`${ui.icon} ${styles.chev}`}
              aria-hidden="true"
            />
            Branch, title and custom model
          </button>
          <div id={advancedId} className={styles.adv} hidden={!advanced}>
            {advanced && (
              <>
                <TextField
                  label="Title"
                  placeholder="Defaults to the first line of the prompt"
                  value={form.title}
                  onChange={value => set('title', value)}
                  className={styles.wide}
                />
                <TextField
                  label="Base"
                  icon={<RiGitBranchLine aria-hidden="true" />}
                  value={form.base}
                  onChange={value => set('base', value)}
                />
                <TextField
                  label="Branch"
                  placeholder="cloud-agent/<id>"
                  value={form.branch}
                  onChange={value => set('branch', value)}
                  className={styles.span2}
                />
                <Checkbox
                  isSelected={form.custom}
                  onChange={value => set('custom', value)}
                  className={styles.wide}
                >
                  Use a harness and model instead of a tier
                </Checkbox>
                <Select
                  label="Harness"
                  isDisabled={!form.custom}
                  selectedKey={form.harness}
                  onSelectionChange={key =>
                    key && set('harness', key as Harness)
                  }
                  options={HARNESSES.map(h => ({ id: h, label: h }))}
                />
                <TextField
                  label="Model"
                  isDisabled={!form.custom}
                  placeholder="claude-sonnet-5-5"
                  value={form.model}
                  onChange={value => set('model', value)}
                />
                <Select
                  label="Effort"
                  isDisabled={!form.custom}
                  selectedKey={form.effort}
                  onSelectionChange={key => key && set('effort', String(key))}
                  options={EFFORTS.map(e => ({ id: e, label: e }))}
                />
              </>
            )}
          </div>
        </div>
        <aside className={`${ui.card} ${styles.summary}`} aria-label="Summary">
          <h3>Ready to start</h3>
          <dl className={styles.kv}>
            <dt>Title</dt>
            <dd title={form.title.trim() || undefined}>
              {form.title.trim() || (
                <span className={styles.muted}>from the prompt</span>
              )}
            </dd>
            <dt>Repository</dt>
            <dd>
              {form.repo.trim() || (
                <span className={styles.muted}>not chosen</span>
              )}
            </dd>
            <dt>Branch</dt>
            <dd className={ui.mono}>
              {form.branch.trim() || 'cloud-agent/<id>'}
            </dd>
            <dt>From</dt>
            <dd className={ui.mono}>{form.base.trim() || 'main'}</dd>
            <dt>Runs on</dt>
            <dd>{runsOn(form, tier)}</dd>
            <dt>Effort</dt>
            <dd>{form.custom ? form.effort : tier?.effort ?? 'high'}</dd>
          </dl>
          {error && (
            <InlineAlert tone="error">
              {serverMissing ? (
                <>
                  Set your {serverMissing} credential in{' '}
                  <Link to={`${base}/settings`}>settings</Link> first.
                </>
              ) : (
                error.message
              )}
            </InlineAlert>
          )}
          <Button
            type="submit"
            variant="primary"
            iconStart={<RiSparkling2Line aria-hidden="true" />}
            isDisabled={Boolean(missing)}
            isPending={submitting}
            className={styles.start}
          >
            Start {KIND[form.kind].name.toLowerCase()}
          </Button>
          <div className={styles.hint}>
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd> from anywhere in the form
          </div>
          {missing && (
            <p className={styles.blocked}>
              <RiKeyLine className={ui.iconXs} aria-hidden="true" />
              Start is off until the credential is set.
            </p>
          )}
        </aside>
      </form>
    </section>
  );
}
