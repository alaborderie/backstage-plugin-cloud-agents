import { type Entity } from '@backstage/catalog-model';

export const entities: Entity[] = [
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'keyroll',
      title: 'Keyroll repository',
      description: 'Repository for the Keyroll service.',
      annotations: { 'github.com/project-slug': 'alaborderie/keyroll' },
    },
    spec: { type: 'repository', lifecycle: 'production', owner: 'antoine' },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'keyroll-api',
      title: 'Keyroll API',
      description: 'Deployed Keyroll API.',
      annotations: {
        'github.com/project-slug': 'alaborderie/keyroll',
        'backstage.io/kubernetes-namespace': 'keyroll',
        'backstage.io/kubernetes-id': 'keyroll-api',
        'backstage.io/kubernetes-label-selector': 'app=keyroll-api',
      },
      links: [{ title: 'API host', url: 'https://keyroll.example.com' }],
    },
    spec: { type: 'api', lifecycle: 'production', owner: 'antoine' },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'without-repo', title: 'Workload without a repository' },
    spec: { type: 'service', lifecycle: 'production', owner: 'antoine' },
  },
];
