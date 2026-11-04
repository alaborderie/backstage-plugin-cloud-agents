import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** Points git at gh for GitHub credentials, so GH_TOKEN never lands in a remote URL or a config file. */
export async function configureGit(env: Record<string, string>): Promise<void> {
  await check('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { env });
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
  const remote = await runProc('git', ['ls-remote', '--exit-code', '--heads', 'origin', spec.branch], { env, cwd: workdir });
  const branchExisted = remote.code === 0;
  await git('fetch', '--quiet', 'origin', branchExisted ? spec.branch : spec.base);
  await git('checkout', '--quiet', '-B', spec.branch, 'FETCH_HEAD');
  if (branchExisted) await git('branch', '--quiet', '--set-upstream-to', `origin/${spec.branch}`);
  return { head_sha: await git('rev-parse', 'HEAD'), branch_existed: branchExisted };
}

export async function branchState(spec: WorkspaceSpec): Promise<BranchState> {
  const { env, workdir } = spec;
  if (!existsSync(join(workdir, '.git'))) return { head_sha: null, pushed: false, pr_url: null };
  const head = await runProc('git', ['rev-parse', 'HEAD'], { env, cwd: workdir });
  const headSha = head.code === 0 ? head.stdout.trim() : null;
  const remote = await runProc('git', ['ls-remote', 'origin', `refs/heads/${spec.branch}`], { env, cwd: workdir });
  const remoteSha = remote.code === 0 ? (remote.stdout.split(/\s/)[0] ?? '') : '';
  const pr = await runProc(
    'gh',
    ['pr', 'list', '--repo', spec.repo, '--head', spec.branch, '--state', 'all', '--limit', '1', '--json', 'url', '--jq', '.[0].url // ""'],
    { env, cwd: workdir },
  );
  const prUrl = pr.code === 0 ? pr.stdout.trim() : '';
  return { head_sha: headSha, pushed: headSha !== null && remoteSha === headSha, pr_url: prUrl === '' ? null : prUrl };
}
