import {
  Link,
  Route,
  Routes,
  useParams,
  useResolvedPath,
} from 'react-router-dom';
import { useApi } from '@backstage/frontend-plugin-api';
import { ButtonLink, Skeleton } from '@backstage/ui';
import { RiChatNewLine } from '@remixicon/react';
import type { Conversation } from '@alaborderie/plugin-assistant-common';
import { assistantApiRef } from '../api';
import { ago } from '../format';
import { useLoad, useNow } from '../hooks';
import { ConversationPane } from './ConversationPane';
import { ui } from './ui';
import styles from './Assistant.module.css';

function ConversationList(props: {
  base: string;
  selectedId: string | undefined;
  conversations: Conversation[] | undefined;
  error: Error | undefined;
}) {
  const now = useNow(30_000);
  const { conversations } = props;
  return (
    <nav className={styles.side} aria-label="Conversations">
      <div className={styles.sideHead}>
        <h1>Assistant</h1>
        <ButtonLink
          href={props.base}
          variant="secondary"
          size="small"
          iconStart={<RiChatNewLine aria-hidden="true" />}
        >
          New chat
        </ButtonLink>
      </div>
      {props.error && !conversations && (
        <p className={styles.sideNote} role="alert">
          Could not load your conversations. {props.error.message}
        </p>
      )}
      {!conversations && !props.error && (
        <div className={styles.sideList} aria-busy="true">
          {[0, 1, 2].map(i => (
            <Skeleton key={i} height={36} />
          ))}
        </div>
      )}
      {conversations?.length === 0 && (
        <p className={styles.sideNote}>Your conversations appear here.</p>
      )}
      {!!conversations?.length && (
        <ul className={styles.sideList}>
          {conversations.map(c => (
            <li key={c.id}>
              <Link
                to={`${props.base}/${encodeURIComponent(c.id)}`}
                className={styles.convo}
                aria-current={c.id === props.selectedId ? 'page' : undefined}
              >
                <span className={styles.convoTitle}>
                  {c.title || 'New chat'}
                </span>
                <span className={styles.convoTime}>
                  {ago(c.updatedAt, now)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function AssistantLayout(props: { base: string }) {
  const { conversationId } = useParams();
  const api = useApi(assistantApiRef);
  const conversations = useLoad(() => api.listConversations(), [api]);
  return (
    <div className={`${ui.scope} ${styles.root}`}>
      <ConversationList
        base={props.base}
        selectedId={conversationId}
        conversations={conversations.value}
        error={conversations.error}
      />
      <ConversationPane
        base={props.base}
        conversationId={conversationId}
        onChanged={conversations.reload}
      />
    </div>
  );
}

/** The chat page: conversations on the left, the open one on the right. */
export function AssistantPage() {
  const base = useResolvedPath('.').pathname.replace(/\/$/, '');
  return (
    <Routes>
      <Route
        path="/:conversationId?"
        element={<AssistantLayout base={base} />}
      />
    </Routes>
  );
}
