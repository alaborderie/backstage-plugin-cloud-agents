export interface Config {
  assistant?: {
    /** The chat model: any OpenAI-compatible Chat Completions endpoint. */
    chatModel?: {
      /**
       * Falls back to env ASSISTANT_OPENCODE_GO_API_KEY. Without one, messages
       * fail with 503.
       * @visibility secret
       */
      apiKey?: string;
      /** Default `https://opencode.ai/inference/go/openai/v1`. */
      baseUrl?: string;
      /** Default `deepseek-v4.1-flash`. */
      model?: string;
    };
    /** The model of the `ask_reasoning_model` tool, on the Anthropic API. */
    reasoningModel?: {
      /** Default `claude-opus-5-5`. */
      model?: string;
    };
  };
}
