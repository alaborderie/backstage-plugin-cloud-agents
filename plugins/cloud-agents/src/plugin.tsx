import {
  ApiBlueprint,
  PageBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  createRouteRef as createLegacyRouteRef,
} from '@backstage/core-plugin-api';
import { RiRobot2Line } from '@remixicon/react';
import { CloudAgentsClient, cloudAgentsApiRef } from './api';
import { rootRouteRef } from './routes';
import { cloudAgentsHomeWidget } from './widget';

const cloudAgentsApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: cloudAgentsApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: deps => new CloudAgentsClient(deps),
    }),
});

const cloudAgentsPage = PageBlueprint.make({
  params: {
    path: '/cloud-agents',
    title: 'Cloud agents',
    icon: <RiRobot2Line />,
    routeRef: rootRouteRef,
    noHeader: true,
    loader: () => import('./components/Root').then(m => <m.CloudAgentsRoot />),
  },
});

/**
 * The cloud-agents plugin for the new frontend system. Feature discovery
 * picks it up; it adds the page at `/cloud-agents`, its nav item, and the
 * Cloud agents home page widget.
 *
 * @public
 */
export const cloudAgentsPlugin = createFrontendPlugin({
  pluginId: 'cloud-agents',
  title: 'Cloud agents',
  icon: <RiRobot2Line />,
  routes: { root: rootRouteRef },
  extensions: [cloudAgentsApi, cloudAgentsPage, cloudAgentsHomeWidget],
});

const legacyRootRouteRef = createLegacyRouteRef({ id: 'cloud-agents' });

/**
 * The plugin for Backstage apps on the legacy frontend system.
 *
 * @public
 */
export const legacyCloudAgentsPlugin = createPlugin({
  id: 'cloud-agents',
  apis: [
    createApiFactory({
      api: cloudAgentsApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: deps => new CloudAgentsClient(deps),
    }),
  ],
  routes: { root: legacyRootRouteRef },
});

/**
 * The page for the legacy frontend system. Mount it at `/cloud-agents`, the
 * path the GitHub callback returns to:
 * `<Route path="/cloud-agents" element={<CloudAgentsPage />} />`.
 *
 * @public
 */
export const CloudAgentsPage = legacyCloudAgentsPlugin.provide(
  createRoutableExtension({
    name: 'CloudAgentsPage',
    component: () => import('./components/Root').then(m => m.CloudAgentsRoot),
    mountPoint: legacyRootRouteRef,
  }),
);
