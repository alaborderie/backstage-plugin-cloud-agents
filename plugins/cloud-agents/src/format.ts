import type {
  AgentStatus,
  RunStatus,
} from '@alaborderie/plugin-cloud-agents-common';

export const STATUS_LABEL: Record<AgentStatus | RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs you',
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

/** Local wall-clock time, "20:23". */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "<1s", "18s", "13m 00s", "1h 05m". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return '<1s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${m}m ${String(s % 60).padStart(2, '0')}s`
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A running timer, "6:15". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** "1 Nov". */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** `acme/api` -> `api`. */
export const repoName = (repo: string) => repo.split('/').pop() ?? repo;

/** The pull request number at the end of a GitHub pull request URL. */
export const prNumber = (url: string) => url.split('/').pop() ?? url;

export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

/** Today, Yesterday, or Earlier, in the viewer's time zone. */
export function dayGroup(
  iso: string,
  now: number,
): 'Today' | 'Yesterday' | 'Earlier' {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t = Date.parse(iso);
  if (t >= startOfToday.getTime()) return 'Today';
  if (t >= startOfToday.getTime() - 86_400_000) return 'Yesterday';
  return 'Earlier';
}

/** Whether a key press comes from a field the user is typing in. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
}
