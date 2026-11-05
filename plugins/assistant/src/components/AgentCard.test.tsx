import { screen, waitFor } from '@testing-library/react';
import type { AgentEventEnvelope } from '@alaborderie/plugin-cloud-agents-common';
import {
  agent,
  agentItem,
  deferred,
  mockApi,
  render,
  summaryItem,
} from '../__testUtils__/fixtures';
import { AgentCard } from './AgentCard';

describe('AgentCard', () => {
  it('asks once for the summary of an agent that already finished', async () => {
    const api = mockApi();
    const onSummary = jest.fn();
    await render(
      <AgentCard
        conversationId="cv_1"
        item={agentItem}
        hasSummary={false}
        onSummary={onSummary}
      />,
      api,
    );
    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
    await waitFor(() => expect(onSummary).toHaveBeenCalledWith(summaryItem));
    expect(api.summarize).toHaveBeenCalledTimes(1);
    expect(api.summarize).toHaveBeenCalledWith('cv_1', agentItem.agentId);
    expect(api.followAgentEvents).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Pull request #12' }),
    ).toBeInTheDocument();
  });

  it('does not ask for a summary the conversation already has', async () => {
    const api = mockApi();
    await render(
      <AgentCard
        conversationId="cv_1"
        item={agentItem}
        hasSummary
        onSummary={jest.fn()}
      />,
      api,
    );
    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
    expect(api.summarize).not.toHaveBeenCalled();
  });

  it('follows a running agent and asks for the summary when it finishes', async () => {
    const finish = deferred();
    let status: 'running' | 'succeeded' = 'running';
    const envelope = (
      seq: number,
      event: AgentEventEnvelope['event'],
    ): AgentEventEnvelope => ({ seq, runId: 'run-1', event });
    const api = mockApi({
      getAgent: jest.fn(async () => agent({ status, prUrl: null })),
      followAgentEvents: jest.fn(async (_id, _after, onEnvelope) => {
        onEnvelope(
          envelope(1, {
            v: 1,
            seq: 1,
            ts: '2026-11-05T10:00:01.000Z',
            run_id: 'run-1',
            type: 'tool.call',
            call_id: 'c1',
            name: 'bash',
            kind: 'shell',
            input: { command: 'yarn test' },
            parent_call_id: null,
          }),
        );
        await finish.promise;
        status = 'succeeded';
        onEnvelope(
          envelope(2, {
            type: 'agent.status',
            status: 'succeeded',
            ts: '2026-11-05T10:01:00.000Z',
          }),
        );
      }),
    });
    const onSummary = jest.fn();
    await render(
      <AgentCard
        conversationId="cv_1"
        item={agentItem}
        hasSummary={false}
        onSummary={onSummary}
      />,
      api,
    );

    expect(await screen.findByText('bash yarn test')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(api.summarize).not.toHaveBeenCalled();

    finish.resolve();
    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
    await waitFor(() => expect(onSummary).toHaveBeenCalledWith(summaryItem));
    expect(api.summarize).toHaveBeenCalledTimes(1);
  });
});
