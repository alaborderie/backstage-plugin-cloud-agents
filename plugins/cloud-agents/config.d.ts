export interface Config {
  cloudAgents?: {
    /**
     * Named presets of harness, model, and effort for `POST /agents`. Without
     * it the plugin uses flash, sol, and opus (see the README).
     * @visibility frontend
     */
    tiers?: {
      [name: string]: {
        /** @visibility frontend */
        harness: 'claude' | 'codex' | 'opencode';
        /** @visibility frontend */
        model: string;
        /** @visibility frontend */
        effort?: string;
      };
    };
  };
}
