import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialHelper } from './github-token.ts';
import { check, runProc } from './proc.ts';

export interface WorkspaceSpec {
  repo: string;
  base: string;
  branch: string;
  workdir: string;
  env: Record<string, string>;
}

export interface BranchState {
  head_sha: string | null;
  pushed: boolean;
  pr_url: string | null;
}

/**
 * Points git at `cloud-agent git-credential` for github.com, so git asks for the run's current token on each
 * use, and no token lands in a remote URL or a config file.
 */
export async function configureGit(env: Record<string, string>): Promise<void> {
  await check('git', ['config', '--global', '--replace-all', 'credential.https://github.com.helper', credentialHelper()], { env });
  const current = await runProc('git', ['config', '--global', 'user.email'], { env });
  if (current.code === 0 && current.stdout.trim() !== '') return;
  const user = JSON.parse(await check('gh', ['api', 'user'], { env })) as { login: string; id: number; name: string | null };
  await check('git', ['config', '--global', 'user.name', user.name ?? user.login], { env });
  await check('git', ['config', '--global', 'user.email', `${String(user.id)}+${user.login}@users.noreply.github.com`], { env });
}

/** Clones the repo and checks out the branch: the remote branch when it exists (a retry or a follow-up run), else a new branch from base. */
export async function prepareWorkspace(spec: WorkspaceSpec): Promise<{ head_sha: string; branch_existed: boolean }> {
  const { env, workdir } = spec;
  if (existsSync(join(workdir, '.git'))) {
    await check('git', ['fetch', '--quiet', 'origin'], { env, cwd: workdir });
  } else {
    mkdirSync(dirname(workdir), { recursive: true });
    await check('git', ['clone', '--quiet', `https://github.com/${spec.repo}.git`, workdir], { env });
  }
  const git = (...args: string[]): Promise<string> => check('git', args, { env, cwd: workdir });
  const remote = await runProc('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${spec.branch}`], { env, cwd: workdir });
  const branchExisted = remote.code === 0;
  await git('fetch', '--quiet', 'origin', branchExisted ? spec.branch : spec.base);
  await git('checkout', '--quiet', '-B', spec.branch, 'FETCH_HEAD');
  if (branchExisted) await git('branch', '--quiet', '--set-upstream-to', `origin/${spec.branch}`);
  return { head_sha: await git('rev-parse', 'HEAD'), branch_existed: branchExisted };
}

export type UnpushedWork =
  | { outcome: 'pushed'; branch: string; commits: number }
  | { outcome: 'push_failed'; branch: string; commits: number; error: string }
  | { outcome: 'not_pushed'; branch: string; commits: number; reason: string };

/**
 * Pushes the checked-out branch when it has commits that no remote branch has, so the work outlives the pod.
 * It never commits, never forces, and never pushes the base or the default branch. `null` when there is
 * nothing to push.
 */
export async function pushUnpushedWork(spec: WorkspaceSpec): Promise<UnpushedWork | null> {
  const { env, workdir } = spec;
  if (!existsSync(join(workdir, '.git'))) return null;
  const git = (...args: string[]) => runProc('git', args, { env, cwd: workdir });
  const branch = (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trim();
  if (branch === '') return null;
  const ahead = await git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin');
  const commits = Number(ahead.stdout.trim());
  if (ahead.code !== 0 || commits === 0) return null;
  const defaultBranch = (await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).stdout.trim().replace(/^origin\//, '');
  if (branch === spec.base || branch === defaultBranch) {
    return { outcome: 'not_pushed', branch, commits, reason: `${branch} is the base or default branch` };
  }
  const push = await git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  if (push.code === 0) return { outcome: 'pushed', branch, commits };
  return { outcome: 'push_failed', branch, commits, error: push.stderr.trim().split('\n').slice(-3).join(' | ') };
}

/** Branches this clone pushed since `since`, from the reflogs of the remote-tracking refs a push updates. */
export async function pushedBranches(spec: WorkspaceSpec, since: Date): Promise<string[]> {
  const log = await runProc('git', ['log', '--walk-reflogs', '--date=unix', '--format=%gD%x09%gs', '--glob=refs/remotes/origin'], {
    env: spec.env,
    cwd: spec.workdir,
  });
  const sinceSeconds = Math.floor(since.getTime() / 1000);
  const branches = new Set<string>();
  for (const line of log.stdout.split('\n')) {
    const match = /^refs\/remotes\/origin\/(.+)@\{(\d+)\}\tupdate by push/.exec(line);
    if (match?.[1] && Number(match[2]) >= sinceSeconds) branches.add(match[1]);
  }
  return [...branches];
}

interface PullRequest {
  url: string;
  state: string;
  createdAt: string;
}

/**
 * The run's pull request: the newest one whose head is `branch`, in any state, as in version 1 of the event
 * stream; else one on a branch the run pushed that is open or was opened during the run.
 */
async function findPullRequest(spec: WorkspaceSpec, since: Date): Promise<string | null> {
  const others = (await pushedBranches(spec, since)).filter((b) => b !== spec.branch);
  for (const head of [spec.branch, ...others]) {
    const list = await runProc(
      'gh',
      ['pr', 'list', '--repo', spec.repo, '--head', head, '--state', 'all', '--limit', '20', '--json', 'url,state,createdAt'],
      { env: spec.env, cwd: spec.workdir },
    );
    let prs: PullRequest[];
    try {
      prs = JSON.parse(list.stdout) as PullRequest[];
    } catch {
      continue;
    }
    const pr = head === spec.branch ? prs[0] : prs.find((p) => p.state === 'OPEN' || Date.parse(p.createdAt) >= since.getTime());
    if (pr) return pr.url;
  }
  return null;
}

export async function branchState(spec: WorkspaceSpec, since: Date): Promise<BranchState> {
  const { env, workdir } = spec;
  if (!existsSync(join(workdir, '.git'))) return { head_sha: null, pushed: false, pr_url: null };
  const head = await runProc('git', ['rev-parse', 'HEAD'], { env, cwd: workdir });
  const headSha = head.code === 0 ? head.stdout.trim() : null;
  const remote = await runProc('git', ['ls-remote', 'origin', `refs/heads/${spec.branch}`], { env, cwd: workdir });
  const remoteSha = remote.code === 0 ? (remote.stdout.split(/\s/)[0] ?? '') : '';
  return { head_sha: headSha, pushed: headSha !== null && remoteSha === headSha, pr_url: await findPullRequest(spec, since) };
}
