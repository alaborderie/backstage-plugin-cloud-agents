import Anthropic from '@anthropic-ai/sdk';
import type {
  AuthService,
  DiscoveryService,
} from '@backstage/backend-plugin-api';

const SETTINGS_HINT =
  'Add an Anthropic API key (from console.anthropic.com, starting with sk-ant-api) in Cloud agents > Settings, at /cloud-agents/settings.';

const SYSTEM = `You are the reasoning model behind a Backstage chat assistant. Another model sends you one hard question with the context it gathered. Answer it thoroughly but without padding, in Markdown. Say what you are unsure of.`;

export type ReasoningResult =
  | { answer: string; model: string }
  | { error: string; message: string };

/**
 * Claude, called with the calling user's own Anthropic API key. The
 * cloud-agents plugin stores the key and hands it only to this plugin's
 * service token, so the key never reaches a browser.
 */
export class Reasoner {
  constructor(
    private readonly deps: { discovery: DiscoveryService; auth: AuthService },
    private readonly model: string,
  ) {}

  private async keyOf(userEntityRef: string): Promise<string | null> {
    const { token } = await this.deps.auth.getPluginRequestToken({
      onBehalfOf: await this.deps.auth.getOwnServiceCredentials(),
      targetPluginId: 'cloud-agents',
    });
    const base = await this.deps.discovery.getBaseUrl('cloud-agents');
    const response = await fetch(`${base}/service/anthropic-key`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userEntityRef }),
    });
    if (!response.ok) {
      throw new Error(`cloud-agents answered ${response.status} for the key`);
    }
    return ((await response.json()) as { apiKey: string | null }).apiKey;
  }

  async ask(
    userEntityRef: string,
    question: string,
    context: string | undefined,
  ): Promise<ReasoningResult> {
    const apiKey = await this.keyOf(userEntityRef);
    if (!apiKey) {
      return { error: 'missing_anthropic_key', message: SETTINGS_HINT };
    }
    const client = new Anthropic({ apiKey });
    try {
      const response = await client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: context
              ? `${question}\n\n<context>\n${context}\n</context>`
              : question,
          },
        ],
      });
      if (response.stop_reason === 'refusal') {
        return {
          error: 'refusal',
          message: `Claude declined to answer${
            response.stop_details?.category
              ? ` (${response.stop_details.category})`
              : ''
          }.`,
        };
      }
      const answer = response.content
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('');
      return { answer, model: response.model };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        return {
          error: 'invalid_anthropic_key',
          message: `Anthropic rejected the stored key. ${SETTINGS_HINT}`,
        };
      }
      if (error instanceof Anthropic.RateLimitError) {
        return {
          error: 'rate_limited',
          message: 'Anthropic rate-limited the key; try again in a minute.',
        };
      }
      if (error instanceof Anthropic.APIError) {
        return {
          error: 'anthropic_error',
          message: `Anthropic answered ${error.status}: ${error.message}`,
        };
      }
      throw error;
    }
  }
}
