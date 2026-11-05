import type { Config } from '@backstage/config';
import type { ClaudeCodeOptions } from './reasoning';

/** How long one reasoning call may run before the tool reports a timeout. */
const REASONING_TIMEOUT_MS = 5 * 60 * 1000;

export interface AssistantConfig {
  chatModel: {
    /** `undefined` when no key is configured: messages then fail with 503. */
    apiKey: string | undefined;
    baseUrl: string;
    model: string;
  };
  reasoningModel: ClaudeCodeOptions;
}

export function readAssistantConfig(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): AssistantConfig {
  return {
    chatModel: {
      apiKey:
        config.getOptionalString('assistant.chatModel.apiKey') ||
        env.ASSISTANT_OPENCODE_GO_API_KEY ||
        undefined,
      baseUrl: (
        config.getOptionalString('assistant.chatModel.baseUrl') ??
        'https://opencode.ai/inference/go/openai/v1'
      ).replace(/\/+$/, ''),
      model:
        config.getOptionalString('assistant.chatModel.model') ??
        'deepseek-v4.1-flash',
    },
    reasoningModel: {
      model:
        config.getOptionalString('assistant.reasoningModel.model') ??
        'claude-opus-5-5',
      claudePath:
        config.getOptionalString('assistant.reasoningModel.claudePath') ??
        'claude',
      timeoutMs: REASONING_TIMEOUT_MS,
    },
  };
}
