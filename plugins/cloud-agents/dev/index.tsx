import '@backstage/cli/asset-types';
// The dev app is an app, so it loads the BUI stylesheet the way an app does.
// eslint-disable-next-line @backstage/no-ui-css-imports-in-non-frontend
import '@backstage/ui/css/styles.css';
import './ember-preview.css';
import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { createApp } from '@backstage/frontend-defaults';
import {
  ApiBlueprint,
  createFrontendModule,
} from '@backstage/frontend-plugin-api';
import { SignInPage, UserIdentity } from '@backstage/core-components';
import {
  NavContentBlueprint,
  SignInPageBlueprint,
} from '@backstage/plugin-app-react';
import cloudAgentsPlugin, { cloudAgentsApiRef } from '../src';
import { MockCloudAgentsApi } from './mockApi';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { InMemoryCatalogClient } from '@backstage/catalog-client/testUtils';
import { entities } from './entities';

/*
 * `?mock` on any page switches this tab to invented data and a scripted live
 * run, so every screen works without a cluster. `?mock=0` switches it back.
 */
const font = document.createElement('link');
font.rel = 'stylesheet';
font.href =
  'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';
document.head.append(font);

const MOCK_KEY = 'cloud-agents-dev-mock';
const param = new URLSearchParams(window.location.search).get('mock');
if (param !== null) {
  if (param === '0') sessionStorage.removeItem(MOCK_KEY);
  else sessionStorage.setItem(MOCK_KEY, '1');
}
const mock = sessionStorage.getItem(MOCK_KEY) === '1';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      <SignInPage {...props} auto providers={['guest']} />,
  },
});

/** The real app brings its own navigation; the dev app shows the page alone. */
const noNav = NavContentBlueprint.make({
  params: { component: () => null },
});

const mockSignIn = SignInPageBlueprint.make({
  params: {
    loader: async () =>
      function GuestSignIn(props) {
        useEffect(
          () => props.onSignInSuccess(UserIdentity.createGuest()),
          [props],
        );
        return null;
      },
  },
});

const mockApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: cloudAgentsApiRef,
      deps: {},
      factory: () => new MockCloudAgentsApi(),
    }),
});

const app = createApp({
  features: [
    cloudAgentsPlugin,
    catalogPlugin,
    createFrontendModule({ pluginId: 'app', extensions: [noNav] }),
    ...(mock
      ? [
          createFrontendModule({
            pluginId: 'catalog',
            extensions: [
              ApiBlueprint.make({
                params: defineParams =>
                  defineParams({
                    api: catalogApiRef,
                    deps: {},
                    factory: () => new InMemoryCatalogClient({ entities }),
                  }),
              }),
            ],
          }),
          createFrontendModule({ pluginId: 'app', extensions: [mockSignIn] }),
          createFrontendModule({
            pluginId: 'cloud-agents',
            extensions: [mockApi],
          }),
        ]
      : [createFrontendModule({ pluginId: 'app', extensions: [signInPage] })]),
  ],
});

ReactDOM.createRoot(document.getElementById('root')!).render(app.createRoot());
