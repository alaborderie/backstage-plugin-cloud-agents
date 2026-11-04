/**
 * Frontend plugin for cloud coding agents: the agents list, an agent's live
 * event timeline and questions, the new agent form, and per-user
 * credentials and access tokens.
 *
 * @packageDocumentation
 */
export {
  cloudAgentsPlugin as default,
  legacyCloudAgentsPlugin,
  CloudAgentsPage,
} from './plugin';
export {
  cloudAgentsApiRef,
  CloudAgentsClient,
  CloudAgentsApiError,
  type CloudAgentsApi,
} from './api';
