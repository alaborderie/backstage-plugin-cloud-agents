import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Button, Radio, RadioGroup, TextAreaField } from '@backstage/ui';
import { useApi } from '@backstage/frontend-plugin-api';
import { RiQuestionLine, RiSendPlaneLine } from '@remixicon/react';
import type {
  Agent,
  OpenQuestion,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef } from '../../api';
import { elapsed, isTyping } from '../../format';
import { useNotify, useNow } from '../../hooks';
import { InlineAlert, Kbd, LiveDot, ui } from '../ui';
import type { Ev } from './timeline';
import styles from './Detail.module.css';

const isSend = (e: { key: string; metaKey: boolean; ctrlKey: boolean }) =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey);

function Working(props: { agent: Agent }) {
  const now = useNow();
  const run = props.agent.runs[props.agent.runs.length - 1];
  const queued = props.agent.status === 'queued';
  return (
    <div className={styles.composer} role="status">
      <div className={styles.working}>
        <LiveDot />
        <span>
          {queued
            ? 'Queued. The Job starts when the cluster schedules it.'
            : 'The agent is working. Follow-ups open when this run ends.'}
        </span>
        <span className={styles.spacer} />
        {!queued && run && (
          <span className={ui.elapsed} role="timer" aria-label="Elapsed">
            {elapsed(now - Date.parse(run.startedAt))}
          </span>
        )}
      </div>
    </div>
  );
}

interface Option {
  label: string;
  description: string | null;
}

/** The open question's options, with descriptions from its `question` event. */
function optionsOf(
  question: OpenQuestion,
  events: ReadonlyMap<string, Ev<'question'>>,
): Option[] {
  const event = events.get(`${question.runId}:${question.questionId}`);
  return question.options.map(label => ({
    label,
    description:
      event?.options.find(o => o.label === label)?.description ?? null,
  }));
}

function Ask(props: {
  agent: Agent;
  questionEvents: ReadonlyMap<string, Ev<'question'>>;
  initialPick: number | undefined;
  onAnswered(question: OpenQuestion, answer: string): void;
  onResumed(): void;
}) {
  const api = useApi(cloudAgentsApiRef);
  const notify = useNotify();
  const [questions] = useState(props.agent.openQuestions);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | undefined>(props.initialPick);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error>();
  const formRef = useRef<HTMLFormElement>(null);

  const question = questions[index];
  const options = question ? optionsOf(question, props.questionEvents) : [];
  const answer =
    picked !== undefined ? options[picked]?.label ?? '' : draft.trim();
  const last = index + 1 >= questions.length;
  const nextRun = props.agent.runs.length + 1;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isSend(event)) {
        event.preventDefault();
        formRef.current?.requestSubmit();
        return;
      }
      if (isTyping(event.target) || event.metaKey || event.ctrlKey) return;
      const k = Number(event.key) - 1;
      if (Number.isInteger(k) && k >= 0 && k < options.length) {
        event.preventDefault();
        setPicked(k);
        setDraft('');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [options.length]);

  if (!question) {
    return (
      <div className={styles.composer} role="status">
        <div className={styles.working}>
          <span className={ui.spinner} aria-hidden="true" />
          Starting run {nextRun} with your answers…
        </div>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!answer || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await api.reply(props.agent.id, question.questionId, answer);
      props.onAnswered(question, answer);
      setPicked(undefined);
      setDraft('');
      setIndex(i => i + 1);
      if (last) {
        notify({
          title: 'Answers sent',
          description: `Run ${nextRun} starts on ${props.agent.branch}.`,
          status: 'info',
        });
        props.onResumed();
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      ref={formRef}
      className={styles.composer}
      data-mode="ask"
      aria-label="Answer the agent"
      onSubmit={submit}
    >
      <div className={styles.cHead}>
        <RiQuestionLine className={ui.icon} aria-hidden="true" />
        <b>The agent asks</b>
        <span className={styles.step}>
          Question {index + 1} of {questions.length}
        </span>
      </div>
      <p className={styles.question} id={`q-${question.questionId}`}>
        {question.question}
      </p>
      {options.length > 0 && (
        <RadioGroup
          aria-label="Suggested answers"
          className={styles.options}
          value={picked === undefined ? null : String(picked)}
          onChange={value => {
            setPicked(Number(value));
            setDraft('');
          }}
        >
          {options.map((option, k) => (
            <Radio key={option.label} value={String(k)} className={styles.opt}>
              <span className={styles.optKey} aria-hidden="true">
                {k + 1}
              </span>
              <span>
                <b>{option.label}</b>
                {option.description && <span>{option.description}</span>}
              </span>
            </Radio>
          ))}
        </RadioGroup>
      )}
      <div className={styles.cInput}>
        <TextAreaField
          aria-label="Your answer"
          placeholder={
            options.length ? 'Or write your own answer' : 'Write your answer'
          }
          rows={1}
          value={draft}
          onChange={value => {
            setDraft(value);
            if (value.trim()) setPicked(undefined);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          isDisabled={!answer}
          isPending={sending}
        >
          {last ? 'Answer and resume' : 'Next'}
        </Button>
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className={styles.cFoot}>
        {options.length > 0 && (
          <span>
            {options.slice(0, 2).map((_, k) => (
              <Kbd key={k}>{k + 1}</Kbd>
            ))}{' '}
            pick
          </span>
        )}
        <span>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> send
        </span>
        <span className={styles.spacer} />
        <span>
          When every question has an answer, run {nextRun} starts on the same
          branch.
        </span>
      </div>
    </form>
  );
}

const RETRY = 'Retry the last run.';
const RETRY_WITH_CONTEXT = 'Retry the last run, and take this into account: ';

function FollowUp(props: { agent: Agent; onSent(): void }) {
  const api = useApi(cloudAgentsApiRef);
  const notify = useNotify();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error>();
  const formRef = useRef<HTMLFormElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const failed = props.agent.status === 'failed';
  const nextRun = props.agent.runs.length + 1;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await api.message(props.agent.id, message);
      setText('');
      notify({
        title: 'Follow-up sent',
        description: `Run ${nextRun} starts on ${props.agent.branch}.`,
        status: 'info',
      });
      props.onSent();
    } catch (e) {
      setError(e as Error);
    } finally {
      setSending(false);
    }
  };

  const quick = (value: string) => {
    setText(value);
    const input = wrapRef.current?.querySelector('textarea');
    input?.focus();
    input?.setSelectionRange(value.length, value.length);
  };

  return (
    <form
      ref={formRef}
      className={styles.composer}
      aria-label="Follow-up message"
      onSubmit={submit}
    >
      <div className={styles.cHead}>
        <RiSendPlaneLine className={ui.icon} aria-hidden="true" />
        <b>{failed ? 'Retry or redirect' : 'Follow up'}</b>
        <span className={styles.step}>
          Starts run {nextRun} on {props.agent.branch}
        </span>
      </div>
      {failed && (
        <div className={styles.quick}>
          <button
            type="button"
            className={ui.chip}
            onClick={() => quick(RETRY)}
          >
            Retry
          </button>
          <button
            type="button"
            className={ui.chip}
            onClick={() => quick(RETRY_WITH_CONTEXT)}
          >
            Retry with more context
          </button>
        </div>
      )}
      <div className={styles.cInput} ref={wrapRef}>
        <TextAreaField
          aria-label="Follow-up message"
          placeholder={
            failed
              ? 'Tell the agent what to do differently'
              : 'Ask for changes, or for the next step'
          }
          rows={1}
          value={text}
          onChange={setText}
          onKeyDown={(event: KeyboardEvent) => {
            if (isSend(event)) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          iconStart={<RiSendPlaneLine aria-hidden="true" />}
          isDisabled={!text.trim()}
          isPending={sending}
        >
          Send
        </Button>
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className={styles.cFoot}>
        <span>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> send
        </span>
        <span className={styles.spacer} />
        <span>The agent continues from the pushed commits.</span>
      </div>
    </form>
  );
}

/**
 * The sticky card under the timeline. Its mode follows the agent: working,
 * asking, or ready for a follow-up.
 */
export function Composer(props: {
  agent: Agent;
  questionEvents: ReadonlyMap<string, Ev<'question'>>;
  initialPick: number | undefined;
  onAnswered(question: OpenQuestion, answer: string): void;
  onRestarted(): void;
}) {
  const { agent } = props;
  if (agent.status === 'queued' || agent.status === 'running') {
    return <Working agent={agent} />;
  }
  if (agent.status === 'needs_input') {
    return (
      <Ask
        key={agent.runs.length}
        agent={agent}
        questionEvents={props.questionEvents}
        initialPick={props.initialPick}
        onAnswered={props.onAnswered}
        onResumed={props.onRestarted}
      />
    );
  }
  return <FollowUp agent={agent} onSent={props.onRestarted} />;
}
