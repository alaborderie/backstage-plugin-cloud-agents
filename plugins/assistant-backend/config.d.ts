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
    /**
     * The model of the `ask_reasoning_model` tool, run through the Claude Code
     * CLI with the user's Claude Code token, else on the Anthropic API with
     * their API key.
     */
    reasoningModel?: {
      /** Default `claude-opus-5-5`. */
      model?: string;
      /** The Claude Code executable. Default `claude`, looked up on PATH. */
      claudePath?: string;
    };
  };
}
