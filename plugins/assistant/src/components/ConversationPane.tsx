import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '@backstage/frontend-plugin-api';
import { ButtonLink } from '@backstage/ui';
import {
  RiAddLine,
  RiErrorWarningLine,
  RiSparkling2Line,
} from '@remixicon/react';
import type {
  AgentSummaryItem,
  ConversationItem,
  TurnEvent,
} from '@alaborderie/plugin-assistant-common';
import { assistantApiRef } from '../api';
import { applyTurnEvent } from '../items';
import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { Spinner, ui } from './ui';
import styles from './Assistant.module.css';

const EXAMPLE_PROMPTS = [
  'Which of my components are Rust services?',
  'What are my cloud agents doing?',
  'Where do the TechDocs explain how to deploy to k3s?',
  'Open a PR on alaborderie/cloud-agent-runner-sandbox that adds a CONTRIBUTING.md',
];

/** What the pane shows: no conversation yet, or one being loaded or shown. */
type View =
  | { phase: 'empty' }
  | { phase: 'loading'; id: string }
  | { phase: 'ready'; id: string; items: ConversationItem[] }
  | { phase: 'failed'; id: string; error: Error };

/**
 * A running turn, in the conversation it was sent in; `undefined` while the
 * empty state creates that conversation.
 */
interface Turn {
  conversationId: string | undefined;
  controller: AbortController;
}

/** How close to the bottom still counts as following the stream. */
const STICK_PX = 80;

const viewOf = (id: string | undefined): View =>
  id ? { phase: 'loading', id } : { phase: 'empty' };

/**
 * The conversation the URL names, or the empty state when it names none.
 * Sending from the empty state creates the conversation, moves the URL to it,
 * and keeps streaming into the same pane.
 */
export function ConversationPane(props: {
  conversationId: string | undefined;
  base: string;
  onChanged(): void;
}) {
  const api = useApi(assistantApiRef);
  const navigate = useNavigate();
  const [view, setView] = useState<View>(() => viewOf(props.conversationId));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnError, setTurnError] = useState<string>();
  const [draft, setDraft] = useState('');
  const shownId = useRef<string | undefined | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  useEffect(() => {
    const id = props.conversationId;
    if (id === shownId.current) return;
    shownId.current = id;
    stick.current = true;
    setTurnError(undefined);
    setView(viewOf(id));
    if (!id) return;
    api.getConversation(id).then(
      detail => {
        if (shownId.current === id) {
          setView({ phase: 'ready', id, items: detail.items });
        }
      },
      error => {
        if (shownId.current === id) setView({ phase: 'failed', id, error });
      },
    );
  }, [api, props.conversationId]);

  const update = useCallback((id: string, event: TurnEvent) => {
    setView(v =>
      v.phase === 'ready' && v.id === id
        ? { ...v, items: applyTurnEvent(v.items, event) }
        : v,
    );
  }, []);

  const send = async (text: string) => {
    if (view.phase !== 'ready' && view.phase !== 'empty') return;
    const known = view.phase === 'ready' ? view.id : undefined;
    const controller = new AbortController();
    setTurnError(undefined);
    setTurns(all => [...all, { conversationId: known, controller }]);
    setDraft('');
    stick.current = true;
    let started = false;
    let target = known;
    const create = async () => {
      const created = (await api.createConversation()).id;
      target = created;
      shownId.current = created;
      setView({ phase: 'ready', id: created, items: [] });
      setTurns(all =>
        all.map(t =>
          t.controller === controller ? { ...t, conversationId: created } : t,
        ),
      );
      navigate(`${props.base}/${encodeURIComponent(created)}`);
      onChanged.current();
      return created;
    };
    try {
      const id = known ?? (await create());
      if (controller.signal.aborted) return;
      await api.sendMessage(
        id,
        text,
        event => {
          if (event.type === 'item' && event.item.type === 'user') {
            started = true;
            onChanged.current();
          }
          if (shownId.current !== id) return;
          if (event.type === 'error') setTurnError(event.message);
          update(id, event);
        },
        controller.signal,
      );
    } catch (e) {
      if (!controller.signal.aborted && shownId.current === target) {
        setTurnError((e as Error).message);
        if (!started) setDraft(text);
      }
    } finally {
      setTurns(all => all.filter(t => t.controller !== controller));
      onChanged.current();
    }
  };

  const onSummary = useCallback(
    (item: AgentSummaryItem) =>
      update(item.conversationId, { type: 'item', item }),
    [update],
  );

  const scrollToEnd = useCallback(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(scrollToEnd, [view, scrollToEnd]);

  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(scrollToEnd);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  const shownConversation = view.phase === 'empty' ? undefined : view.id;
  const turn = turns.find(t => t.conversationId === shownConversation);
  const busy = !!turn;
  const items = view.phase === 'ready' ? view.items : [];
  const empty =
    view.phase === 'empty' ||
    (view.phase === 'ready' && !items.length && !busy);

  return (
    <section className={styles.pane} aria-label="Conversation">
      <div className={styles.scroller} ref={scroller} onScroll={onScroll}>
        <div className={styles.column} ref={content}>
          {view.phase === 'loading' && (
            <div className={styles.center}>
              <Spinner label="Loading the conversation" />
            </div>
          )}
          {view.phase === 'failed' && (
            <div className={styles.center} role="alert">
              <RiErrorWarningLine
                className={styles.heroIcon}
                aria-hidden="true"
              />
              <h2>Could not open this conversation</h2>
              <p>{view.error.message}</p>
              <ButtonLink
                href={props.base}
                variant="secondary"
                iconStart={<RiAddLine aria-hidden="true" />}
              >
                New chat
              </ButtonLink>
            </div>
          )}
          {empty && (
            <div className={styles.hero}>
              <span className={styles.heroGlyph} aria-hidden="true">
                <RiSparkling2Line className={ui.icon} />
              </span>
              <h2>What can I help with?</h2>
              <p>
                I answer from your catalog, TechDocs, GitHub, and cloud agents,
                and I can start an agent for you.
              </p>
              <div className={styles.examples}>
                {EXAMPLE_PROMPTS.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    className={styles.example}
                    onClick={() => send(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {view.phase === 'ready' && (
            <Transcript
              conversationId={view.id}
              items={items}
              busy={busy}
              onSummary={onSummary}
            />
          )}
        </div>
      </div>
      <div className={styles.dock}>
        <div className={styles.column}>
          {turnError && (
            <p className={styles.turnError} role="alert">
              <RiErrorWarningLine className={ui.iconXs} aria-hidden="true" />
              {turnError}
            </p>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={() => turn?.controller.abort()}
            busy={busy}
            disabled={view.phase === 'loading' || view.phase === 'failed'}
          />
        </div>
      </div>
    </section>
  );
}
