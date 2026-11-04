import type { HarnessName } from '../events.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { opencode } from './opencode.ts';
import type { Harness } from './types.ts';

export const harnesses: Record<HarnessName, Harness> = { claude, codex, opencode };
