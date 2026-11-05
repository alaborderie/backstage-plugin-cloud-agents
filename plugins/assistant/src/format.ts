import type { AgentStatus } from '@alaborderie/plugin-cloud-agents-common';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs you',
  waiting: 'Waiting on children',
  succeeded: 'Succeeded',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** "just now", "9m ago", "2h ago", "3d ago". */
export function ago(iso: string, now: number): string {
  const s = Math.max(1, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The pull request number at the end of a GitHub pull request URL. */
export const prNumber = (url: string) => url.split('/').pop() ?? url;

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

/** The first line of `text`, at most `max` characters. */
export function firstLine(text: string, max = 200): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
