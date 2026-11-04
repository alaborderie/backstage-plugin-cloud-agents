import ReactDOM from 'react-dom/client';
import { createApp } from '@backstage/frontend-defaults';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { SignInPage } from '@backstage/core-components';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import cloudAgentsPlugin from '../src';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      <SignInPage {...props} auto providers={['guest']} />,
  },
});

const app = createApp({
  features: [
    cloudAgentsPlugin,
    createFrontendModule({ pluginId: 'app', extensions: [signInPage] }),
  ],
});

ReactDOM.createRoot(document.getElementById('root')!).render(app.createRoot());
