import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Chip, Grid, TextField, Typography } from '@material-ui/core';
import Alert from '@material-ui/lab/Alert';
import {
  ErrorPanel,
  InfoCard,
  Link,
  Progress,
} from '@backstage/core-components';
import { useApi } from '@backstage/frontend-plugin-api';
import {
  isTerminalAgentStatus,
  type Agent,
  type OpenQuestion,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef } from '../api';
import { useAgent, useAgentEvents } from '../hooks';
import { StatusChip } from './StatusChip';
import { Timeline } from './Timeline';

const REFRESH_ON = new Set([
  'agent.status',
  'agent.run_started',
  'question',
  'run.finished',
]);

function QuestionCard(props: {
  agentId: string;
  question: OpenQuestion;
  onAnswered(): void;
}) {
  const api = useApi(cloudAgentsApiRef);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.reply(props.agentId, props.question.questionId, answer);
      setAnswer('');
      props.onAnswered();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label={`Answer ${props.question.questionId}`}>
      <Typography variant="subtitle1">{props.question.question}</Typography>
      <div
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}
      >
        {props.question.options.map(option => (
          <Chip key={option} label={option} onClick={() => setAnswer(option)} />
        ))}
      </div>
      <TextField
        id={`answer-${props.question.runId}-${props.question.questionId}`}
        label="Answer"
        fullWidth
        multiline
        value={answer}
        onChange={e => setAnswer(e.target.value)}
      />
      {error && <Alert severity="error">{error.message}</Alert>}
      <Button
        type="submit"
        color="primary"
        variant="contained"
        disabled={busy || !answer.trim()}
        style={{ marginTop: 8 }}
      >
        Answer
      </Button>
    </form>
  );
}

function FollowUp(props: { agentId: string; onSent(): void }) {
  const api = useApi(cloudAgentsApiRef);
  const [text, setText] = useState('');
  const [error, setError] = useState<Error>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.message(props.agentId, text);
      setText('');
      props.onSent();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <form onSubmit={submit} aria-label="Follow-up message">
      <TextField
        id="follow-up-message"
        label="Follow-up message"
        helperText="Starts a new run on the same branch."
        fullWidth
        multiline
        value={text}
        onChange={e => setText(e.target.value)}
      />
      {error && <Alert severity="error">{error.message}</Alert>}
      <Button
        type="submit"
        variant="outlined"
        disabled={!text.trim()}
        style={{ marginTop: 8 }}
      >
        Send
      </Button>
    </form>
  );
}

function Summary(props: { agent: Agent; onStop(): void; stopping: boolean }) {
  const { agent } = props;
  const active = agent.status === 'queued' || agent.status === 'running';
  return (
    <InfoCard
      title={agent.title}
      subheader={`${agent.repo} · ${agent.branch} (from ${agent.base})`}
      action={
        !isTerminalAgentStatus(agent.status) && (
          <Button
            color="secondary"
            variant="outlined"
            onClick={props.onStop}
            disabled={props.stopping}
          >
            Stop
          </Button>
        )
      }
    >
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Typography variant="overline">Status</Typography>
          <div>
            <StatusChip status={agent.status} />
          </div>
        </Grid>
        <Grid item xs={12} md={4}>
          <Typography variant="overline">Model</Typography>
          <Typography>{`${agent.harness} · ${agent.model} (${agent.effort})`}</Typography>
        </Grid>
        <Grid item xs={12} md={4}>
          <Typography variant="overline">Pull request</Typography>
          <Typography>
            {agent.prUrl ? (
              <Link to={agent.prUrl}>{agent.prUrl}</Link>
            ) : (
              'none yet'
            )}
          </Typography>
        </Grid>
        <Grid item xs={12}>
          <Typography variant="overline">Runs</Typography>
          {agent.runs.map((run, i) => (
            <Typography key={run.id} variant="body2">
              {`${i + 1}. ${run.status}${
                run.exitCode === null ? '' : ` (exit ${run.exitCode})`
              }, started ${new Date(run.startedAt).toLocaleString()}`}
            </Typography>
          ))}
          {active && <Progress />}
        </Grid>
      </Grid>
    </InfoCard>
  );
}

export function AgentDetail() {
  const { id = '' } = useParams();
  const api = useApi(cloudAgentsApiRef);
  const agent = useAgent(id);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<Error>();
  const stream = useAgentEvents(id, envelope => {
    if (REFRESH_ON.has(envelope.event.type)) agent.reload();
  });

  if (agent.error) return <ErrorPanel error={agent.error} />;
  if (!agent.value) return <Progress />;

  const stop = async () => {
    setStopping(true);
    try {
      await api.stop(id);
      agent.reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setStopping(false);
    }
  };
  const restarted = () => {
    agent.reload();
    stream.restart();
  };
  const current = agent.value;
  const canMessage =
    current.status !== 'queued' && current.status !== 'running';

  return (
    <Grid container spacing={3}>
      <Grid item xs={12}>
        <Summary agent={current} onStop={stop} stopping={stopping} />
        {actionError && <Alert severity="error">{actionError.message}</Alert>}
      </Grid>
      {current.status === 'needs_input' && current.openQuestions.length > 0 && (
        <Grid item xs={12}>
          <InfoCard title="The agent asks">
            {current.openQuestions.map(q => (
              <QuestionCard
                key={`${q.runId}-${q.questionId}`}
                agentId={id}
                question={q}
                onAnswered={restarted}
              />
            ))}
          </InfoCard>
        </Grid>
      )}
      <Grid item xs={12}>
        <InfoCard title={`Events${stream.live ? ' (live)' : ''}`}>
          {stream.error && (
            <Alert severity="warning">
              Reconnecting: {stream.error.message}
            </Alert>
          )}
          <Timeline events={stream.events} />
        </InfoCard>
      </Grid>
      {canMessage && (
        <Grid item xs={12}>
          <InfoCard title="Follow up">
            <FollowUp agentId={id} onSent={restarted} />
          </InfoCard>
        </Grid>
      )}
    </Grid>
  );
}
