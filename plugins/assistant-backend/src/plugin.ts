import {
  coreServices,
  createBackendPlugin,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import { actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { Assistant } from './assistant';
import { OpenAiCompatibleChatModel } from './chatModel';
import { readAssistantConfig } from './config';
import { PromptBuilder } from './prompt';
import { Reasoner } from './reasoning';
import { createRouter } from './router';
import { Store } from './store';

/**
 * The assistant backend plugin: conversations at `/api/assistant`, each turn
 * streamed from the chat model with tools over the catalog, TechDocs, GitHub,
 * and the cloud-agents actions (docs/ASSISTANT.md).
 *
 * @public
 */
export const assistantPlugin = createBackendPlugin({
  pluginId: 'assistant',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        catalog: catalogServiceRef,
        actions: actionsServiceRef,
      },
      async init({
        config,
        logger,
        database,
        httpRouter,
        httpAuth,
        auth,
        discovery,
        catalog,
        actions,
      }) {
        const settings = readAssistantConfig(config);
        const knex = await database.getClient();
        if (!database.migrations?.skip) {
          await knex.migrate.latest({
            directory: resolvePackagePath(
              '@alaborderie/plugin-assistant-backend',
              'migrations',
            ),
          });
        }
        const store = new Store(knex);
        const { apiKey } = settings.chatModel;
        if (!apiKey) {
          logger.error(
            'No assistant.chatModel.apiKey or ASSISTANT_OPENCODE_GO_API_KEY: every message will fail with 503',
          );
        }
        const integrations = ScmIntegrations.fromConfig(config);
        const github = integrations.github.byHost('github.com')?.config;
        const assistant = new Assistant(
          store,
          apiKey
            ? new OpenAiCompatibleChatModel({ ...settings.chatModel, apiKey })
            : undefined,
          new PromptBuilder(catalog),
          {
            catalog,
            actions,
            discovery,
            auth,
            github: {
              apiBaseUrl: github?.apiBaseUrl ?? 'https://api.github.com',
              credentials:
                DefaultGithubCredentialsProvider.fromIntegrations(integrations),
            },
            reasoner: new Reasoner(
              { discovery, auth },
              settings.reasoningModel,
            ),
          },
          logger,
        );
        httpRouter.use(createRouter({ assistant, store, httpAuth, logger }));
        logger.info(
          `Assistant chat model ${settings.chatModel.model} at ${settings.chatModel.baseUrl}`,
        );
      },
    });
  },
});
