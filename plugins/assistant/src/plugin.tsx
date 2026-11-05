import {
  ApiBlueprint,
  PageBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import { RiChatSmile2Line } from '@remixicon/react';
import { AssistantClient, assistantApiRef } from './api';
import { rootRouteRef } from './routes';

const assistantApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: assistantApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: deps => new AssistantClient(deps),
    }),
});

const assistantPage = PageBlueprint.make({
  params: {
    path: '/assistant',
    title: 'Assistant',
    icon: <RiChatSmile2Line />,
    routeRef: rootRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/AssistantPage').then(m => <m.AssistantPage />),
  },
});

/**
 * The assistant plugin for the new frontend system. Feature discovery picks
 * it up; it adds the chat page at `/assistant` and its nav item.
 *
 * @public
 */
export const assistantPlugin = createFrontendPlugin({
  pluginId: 'assistant',
  title: 'Assistant',
  icon: <RiChatSmile2Line />,
  routes: { root: rootRouteRef },
  extensions: [assistantApi, assistantPage],
});
