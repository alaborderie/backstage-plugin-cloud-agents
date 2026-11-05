import {
  coreServices,
  createBackendPlugin,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { KubeConfig } from '@kubernetes/client-node';
import { registerActions } from './actions';
import { AgentService } from './agents';
import { readCloudAgentsConfig } from './config';
import { CredentialService } from './credentials';
import { CredentialCipher } from './crypto';
import { Followers } from './follower';
import { GithubClient } from './github';
import { Cluster } from './kube';
import { createRouter } from './router';
import { hubRunTokenKey } from './runTokens';
import { Store } from './store';

/**
 * The cloud-agents backend plugin: the API in docs/API.md at
 * `/api/cloud-agents`, one Kubernetes Job per agent run, and the event stream
 * of each agent.
 *
 * @public
 */
export const cloudAgentsPlugin = createBackendPlugin({
  pluginId: 'cloud-agents',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        lifecycle: coreServices.lifecycle,
        actionsRegistry: actionsRegistryServiceRef,
      },
      async init({
        config,
        logger,
        database,
        httpRouter,
        httpAuth,
        lifecycle,
        actionsRegistry,
      }) {
        const settings = readCloudAgentsConfig(config);
        const knex = await database.getClient();
        if (!database.migrations?.skip) {
          await knex.migrate.latest({
            directory: resolvePackagePath(
              '@alaborderie/plugin-cloud-agents-backend',
              'migrations',
            ),
          });
        }

        const kubeConfig = new KubeConfig();
        kubeConfig.loadFromDefault();
        const store = new Store(knex);
        const github = new GithubClient(
          settings.githubApiBaseUrl,
          settings.githubApp,
        );
        const credentials = new CredentialService(
          store,
          new CredentialCipher(settings.encryptionKey),
          github,
          logger,
          settings.job.activeDeadlineSeconds * 1000,
        );
        const cluster = new Cluster(kubeConfig, settings);
        const agents = new AgentService(
          store,
          cluster,
          credentials,
          settings.tiers,
          logger,
          {
            runTokenKey: hubRunTokenKey(settings.encryptionKey),
            hubsAvailable: settings.runnerApiUrl !== undefined,
            activeDeadlineSeconds: settings.job.activeDeadlineSeconds,
            hubWakeDelayMs: settings.hubWakeDelayMs,
          },
        );
        const followers = new Followers(store, agents, cluster, logger, {
          podStartTimeoutMs:
            config.getOptionalNumber('cloudAgents.podStartTimeoutMs') ??
            120_000,
          pollIntervalMs:
            config.getOptionalNumber('cloudAgents.pollIntervalMs') ?? 2000,
        });
        agents.onRunStarted = run => followers.follow(run);

        registerActions(actionsRegistry, agents);

        lifecycle.addStartupHook(async () => {
          await followers.resumeAll();
          await agents.resumeHubs();
        });
        lifecycle.addShutdownHook(() => {
          followers.stopAll();
          agents.stopWakes();
        });

        httpRouter.addAuthPolicy({ path: '/', allow: 'unauthenticated' });
        httpRouter.use(
          createRouter({
            config: settings,
            agents,
            credentials,
            github,
            store,
            httpAuth,
            logger,
          }),
        );
        logger.info(
          `Cloud agents run in namespace ${settings.namespace} with ${settings.runnerImage}`,
        );
      },
    });
  },
});
