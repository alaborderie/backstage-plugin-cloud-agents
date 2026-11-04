#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [output, namespace = 'backstage', serviceAccount = 'backstage'] =
  process.argv.slice(2);
if (!output) {
  throw new Error(
    'Usage: service-account-kubeconfig.mjs <new-output-file> [sa-namespace] [sa-name]',
  );
}
function kubectl(args) {
  const result = spawnSync('kubectl', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `kubectl ${args.join(' ')} failed: ${
        result.error?.message ?? result.stderr
      }`,
    );
  }
  return result.stdout;
}
const source = JSON.parse(
  kubectl(['config', 'view', '--minify', '--flatten', '--raw', '-o', 'json']),
);
const cluster = source.clusters?.[0];
if (!cluster) throw new Error('The current kubeconfig has no cluster');
const token = kubectl([
  '-n',
  namespace,
  'create',
  'token',
  serviceAccount,
  '--duration=1h',
]).trim();
if (!token) throw new Error('Kubernetes returned no ServiceAccount token');
const config = {
  apiVersion: 'v1',
  kind: 'Config',
  clusters: [cluster],
  users: [{ name: 'cloud-agents-verification', user: { token } }],
  contexts: [
    {
      name: 'cloud-agents-verification',
      context: {
        cluster: cluster.name,
        user: 'cloud-agents-verification',
        namespace: 'cloud-agents',
      },
    },
  ],
  'current-context': 'cloud-agents-verification',
};
writeFileSync(output, JSON.stringify(config, null, 2), {
  mode: 0o600,
  flag: 'wx',
});
console.log(`Wrote ServiceAccount kubeconfig to ${output}`);
