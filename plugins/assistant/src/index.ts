/**
 * Frontend plugin for the assistant: a streaming chat that answers from the
 * catalog, TechDocs, GitHub, and cloud agents, and follows the agents it
 * launches.
 *
 * @packageDocumentation
 */
export { assistantPlugin as default } from './plugin';
export {
  assistantApiRef,
  AssistantClient,
  AssistantApiError,
  type AssistantApi,
} from './api';
