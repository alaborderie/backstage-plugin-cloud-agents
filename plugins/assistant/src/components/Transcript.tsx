import type { ReactNode } from 'react';
import { RiFlagLine } from '@remixicon/react';
import type {
  AgentSummaryItem,
  AssistantItem,
  ConversationItem,
  ToolItem,
} from '@alaborderie/plugin-assistant-common';
import { AgentCard } from './AgentCard';
import { Markdown } from './Markdown';
import { ToolChip } from './ToolChip';
import { PrChip, StatusPill, ui } from './ui';
import styles from './Transcript.module.css';

/** An assistant item that only called tools says nothing by itself. */
function isSilent(item: AssistantItem): boolean {
  return (
    !item.text &&
    item.status !== 'error' &&
    (item.toolCalls.length > 0 || item.status === 'done')
  );
}

function AssistantMessage(props: { item: AssistantItem; live: boolean }) {
  const { item } = props;
  return (
    <div className={styles.assistant}>
      <Markdown
        text={item.text}
        streaming={props.live && item.status === 'streaming'}
      />
      {item.status === 'error' && (
        <p className={styles.itemError} role="alert">
          {item.error ?? 'The answer failed.'}
        </p>
      )}
    </div>
  );
}

function SummaryMessage(props: {
  item: AgentSummaryItem;
  title: string | undefined;
}) {
  const { item } = props;
  return (
    <div className={styles.assistant}>
      <div className={styles.summaryHead}>
        <RiFlagLine className={ui.iconXs} aria-hidden="true" />
        <span>Agent finished</span>
        {props.title && (
          <span className={styles.summaryTitle}>· {props.title}</span>
        )}
        <StatusPill status={item.status} />
        {item.prUrl && <PrChip url={item.prUrl} />}
      </div>
      <Markdown text={item.text} />
    </div>
  );
}

function Thinking() {
  return (
    <div className={styles.thinking} role="status" aria-label="Thinking">
      <i />
      <i />
      <i />
    </div>
  );
}

/** Whether the turn already shows its progress, so no thinking dots are needed. */
function showsProgress(item: ConversationItem | undefined): boolean {
  return (
    (item?.type === 'assistant' && item.status === 'streaming') ||
    (item?.type === 'tool' && item.status === 'running')
  );
}

/** The conversation's items in seq order; consecutive tool calls group tightly. */
export function Transcript(props: {
  conversationId: string;
  items: ConversationItem[];
  busy: boolean;
  onSummary(item: AgentSummaryItem): void;
}) {
  const { items } = props;
  const summarized = new Set(
    items.flatMap(i => (i.type === 'agent_summary' ? [i.agentId] : [])),
  );
  const titles = new Map(
    items.flatMap(i =>
      i.type === 'agent' ? [[i.agentId, i.title] as const] : [],
    ),
  );

  const blocks: ReactNode[] = [];
  let tools: ToolItem[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    blocks.push(
      <div key={`tools-${tools[0]!.id}`} className={styles.tools}>
        {tools.map(tool => (
          <ToolChip key={tool.id} item={tool} live={props.busy} />
        ))}
      </div>,
    );
    tools = [];
  };
  for (const item of items) {
    if (item.type === 'tool') {
      tools.push(item);
      continue;
    }
    if (item.type === 'assistant' && isSilent(item)) continue;
    flushTools();
    switch (item.type) {
      case 'user':
        blocks.push(
          <div key={item.id} className={styles.user}>
            <p>{item.text}</p>
          </div>,
        );
        break;
      case 'assistant':
        blocks.push(
          <AssistantMessage key={item.id} item={item} live={props.busy} />,
        );
        break;
      case 'agent':
        blocks.push(
          <AgentCard
            key={item.id}
            conversationId={props.conversationId}
            item={item}
            hasSummary={summarized.has(item.agentId)}
            onSummary={props.onSummary}
          />,
        );
        break;
      case 'agent_summary':
        blocks.push(
          <SummaryMessage
            key={item.id}
            item={item}
            title={titles.get(item.agentId)}
          />,
        );
        break;
      default:
    }
  }
  flushTools();

  return (
    <div className={styles.transcript}>
      {blocks}
      {props.busy && !showsProgress(items[items.length - 1]) && <Thinking />}
    </div>
  );
}
