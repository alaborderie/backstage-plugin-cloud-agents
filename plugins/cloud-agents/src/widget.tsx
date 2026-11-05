import { HomePageWidgetBlueprint } from '@backstage/plugin-home-react/alpha';

/**
 * The Cloud agents home page widget: agents that need you, running and
 * queued agents, and what finished today.
 *
 * @alpha
 */
export const cloudAgentsHomeWidget = HomePageWidgetBlueprint.make({
  name: 'cloud-agents',
  params: {
    title: 'Cloud agents',
    description:
      'Agents that need your answer, what running agents do now, and what finished today.',
    layout: {
      width: { minColumns: 4, defaultColumns: 5 },
      height: { minRows: 3, defaultRows: 4 },
    },
    components: () =>
      import('./components/widget/CloudAgentsWidget').then(m => ({
        Content: m.CloudAgentsWidget,
      })),
  },
});
