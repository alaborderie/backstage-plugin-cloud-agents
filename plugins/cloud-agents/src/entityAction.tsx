import { stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import { useEntity } from '@backstage/plugin-catalog-react';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { useRouteRef } from '@backstage/frontend-plugin-api';
import { ButtonLink, Card, CardBody } from '@backstage/ui';
import { RiRobot2Line } from '@remixicon/react';
import { rootRouteRef } from './routes';

export function entityAgentPrompt(entity: Entity, entityUrl: string): string {
  const annotations = entity.metadata.annotations ?? {};
  const lines = [
    'Entity context for the task you will write below.',
    `Title: ${entity.metadata.title ?? entity.metadata.name}`,
    `Entity: ${stringifyEntityRef(entity)}`,
    `Kind: ${entity.kind}`,
  ];
  if (entity.spec?.type) lines.push(`Type: ${entity.spec.type}`);
  if (entity.metadata.description) {
    lines.push(`Description: ${entity.metadata.description}`);
  }
  for (const link of entity.metadata.links ?? []) {
    lines.push(`Link: ${link.title ? `${link.title}: ` : ''}${link.url}`);
  }
  for (const key of [
    'backstage.io/kubernetes-namespace',
    'backstage.io/kubernetes-id',
    'backstage.io/kubernetes-label-selector',
    'backstage.io/kubernetes-cluster',
  ]) {
    if (annotations[key]) lines.push(`${key}: ${annotations[key]}`);
  }
  lines.push(`Catalog page: ${entityUrl}`, '', 'Task:', '');
  return lines.join('\n');
}

function EntityNewAgentAction() {
  const { entity } = useEntity();
  const root = useRouteRef(rootRouteRef);
  const params = new URLSearchParams({
    repo: entity.metadata.annotations!['github.com/project-slug']!,
    prompt: entityAgentPrompt(entity, window.location.href),
  });
  return (
    <Card>
      <CardBody>
        <ButtonLink
          href={`${root?.() ?? '/cloud-agents'}/new?${params}`}
          iconStart={<RiRobot2Line />}
        >
          New agent
        </ButtonLink>
      </CardBody>
    </Card>
  );
}

export const cloudAgentsEntityAction = EntityCardBlueprint.make({
  name: 'new-agent',
  params: {
    type: 'info',
    filter: entity =>
      Boolean(entity.metadata.annotations?.['github.com/project-slug']),
    loader: async () => <EntityNewAgentAction />,
  },
});
