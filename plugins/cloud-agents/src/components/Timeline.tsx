import type { ReactNode } from 'react';
import { Box, Typography, makeStyles } from '@material-ui/core';
import { Link } from '@backstage/core-components';
import type {
  AgentEventEnvelope,
  PluginEvent,
  RunnerEvent,
} from '@alaborderie/plugin-cloud-agents-common';

type AnyEvent = RunnerEvent | PluginEvent;
type Tone = 'normal' | 'muted' | 'error' | 'success';

const STATUS_TONE: Partial<Record<string, Tone>> = {
  succeeded: 'success',
  failed: 'error',
};

interface Row {
  title: string;
  body?: ReactNode;
  tone?: Tone;
}

const useStyles = makeStyles(theme => ({
  row: {
    display: 'grid',
    gridTemplateColumns: '3.5rem 1fr',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 0),
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  seq: { color: theme.palette.text.secondary, fontFamily: 'monospace' },
  muted: { color: theme.palette.text.secondary },
  error: { color: theme.palette.error.main },
  success: { color: theme.palette.success.main },
  normal: {},
  pre: {
    margin: theme.spacing(0.5, 0, 0),
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    maxHeight: '20rem',
    overflow: 'auto',
  },
}));

function Pre(props: { children: string }) {
  const classes = useStyles();
  return <pre className={classes.pre}>{props.children}</pre>;
}

function summarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of [
      'command',
      'cmd',
      'file_path',
      'filePath',
      'path',
      'pattern',
      'description',
    ]) {
      const value = record[key];
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join(' ');
    }
  }
  return JSON.stringify(input, null, 2);
}

/** How each event type reads in the timeline. Unknown types show their JSON. */
const RENDERERS: {
  [T in AnyEvent['type']]: (e: Extract<AnyEvent, { type: T }>) => Row;
} = {
  'agent.run_started': e => ({
    title: `Run started (${e.reason})`,
    tone: 'muted',
  }),
  'agent.status': e => ({
    title: `Agent ${e.status.replace('_', ' ')}`,
    tone: STATUS_TONE[e.status] ?? 'muted',
    ...(e.error && { body: <Pre>{e.error}</Pre> }),
  }),
  'run.started': e => ({
    title: `Runner ${e.runner_version}: ${e.harness} ${e.model} (${e.effort}) on ${e.repo}@${e.branch}`,
    tone: 'muted',
  }),
  'skills.ready': e => ({
    title: `Skills ready at ${e.commit.slice(0, 7)}`,
    tone: 'muted',
  }),
  'workspace.ready': e => ({
    title: `Workspace ready: ${e.branch} at ${e.head_sha.slice(0, 7)}${
      e.branch_existed ? ' (existing branch)' : ''
    }`,
    tone: 'muted',
  }),
  'session.started': e => ({ title: `Session ${e.session_id}`, tone: 'muted' }),
  'assistant.message': e => ({ title: 'Agent', body: <Pre>{e.text}</Pre> }),
  'tool.call': e => ({
    title: `${e.name} (${e.kind})`,
    body: <Pre>{summarize(e.input)}</Pre>,
  }),
  'tool.result': e => ({
    title: e.is_error ? 'Tool error' : 'Tool result',
    tone: e.is_error ? 'error' : 'muted',
    ...(e.output && {
      body: <Pre>{`${e.output}${e.truncated ? '\n…' : ''}`}</Pre>,
    }),
  }),
  question: e => ({
    title: `Question${e.blocking ? ' (blocking)' : ''}: ${e.question}`,
    ...(e.options.length > 0 && {
      body: e.options.map(o => o.label).join(' · '),
    }),
  }),
  usage: e => ({
    title: `Usage: ${e.input_tokens} in, ${e.output_tokens} out${
      e.cost_usd ? `, $${e.cost_usd.toFixed(4)}` : ''
    }`,
    tone: 'muted',
  }),
  rate_limit: e => ({
    title: `Rate limit ${e.status}${e.window ? ` (${e.window})` : ''}`,
    tone: e.status === 'limited' ? 'error' : 'muted',
    ...(e.message && { body: e.message }),
  }),
  log: e => ({
    title: `${e.source} ${e.level}`,
    tone: e.level === 'error' ? 'error' : 'muted',
    body: <Pre>{e.message}</Pre>,
  }),
  'run.finished': e => ({
    title: `Run ${e.status} (exit ${e.exit_code}) in ${Math.round(
      e.duration_ms / 1000,
    )} s`,
    tone: STATUS_TONE[e.status] ?? 'normal',
    body: (
      <>
        {e.pr_url && <Link to={e.pr_url}>{e.pr_url}</Link>}
        {e.error && <Pre>{e.error}</Pre>}
      </>
    ),
  }),
};

function renderRow(event: AnyEvent): Row {
  const render = RENDERERS[event.type] as ((e: AnyEvent) => Row) | undefined;
  return render
    ? render(event)
    : {
        title: event.type,
        body: <Pre>{JSON.stringify(event, null, 2)}</Pre>,
        tone: 'muted',
      };
}

export function Timeline(props: { events: AgentEventEnvelope[] }) {
  const classes = useStyles();
  if (!props.events.length) {
    return (
      <Typography className={classes.muted}>Waiting for events…</Typography>
    );
  }
  return (
    <Box role="log" aria-label="Agent events">
      {props.events.map(envelope => {
        const row = renderRow(envelope.event);
        return (
          <div
            key={envelope.seq}
            className={classes.row}
            data-seq={envelope.seq}
          >
            <span className={classes.seq}>#{envelope.seq}</span>
            <div>
              <Typography
                variant="body2"
                className={classes[row.tone ?? 'normal']}
              >
                {row.title}
              </Typography>
              {row.body}
            </div>
          </div>
        );
      })}
    </Box>
  );
}
