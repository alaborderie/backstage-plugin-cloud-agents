import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
} from '@material-ui/core';
import {
  ErrorPanel,
  Link,
  Table,
  type TableColumn,
} from '@backstage/core-components';
import { useApi } from '@backstage/frontend-plugin-api';
import {
  AGENT_STATUSES,
  type Agent,
  type AgentStatus,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef } from '../api';
import { useBasePath, useLoad } from '../hooks';
import { StatusChip } from './StatusChip';

const REFRESH_MS = 5000;

export function AgentsList() {
  const api = useApi(cloudAgentsApiRef);
  const base = useBasePath();
  const [status, setStatus] = useState<AgentStatus | ''>('');
  const agents = useLoad(
    () => api.listAgents(status || undefined),
    [api, status],
  );
  const { reload } = agents;
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const columns: TableColumn<Agent>[] = [
    {
      title: 'Agent',
      field: 'title',
      render: a => <Link to={`${base}/agents/${a.id}`}>{a.title}</Link>,
    },
    {
      title: 'Status',
      field: 'status',
      render: a => <StatusChip status={a.status} />,
    },
    { title: 'Repository', render: a => `${a.repo} · ${a.branch}` },
    { title: 'Model', render: a => `${a.harness} · ${a.model}` },
    {
      title: 'Pull request',
      render: a =>
        a.prUrl ? (
          <Link to={a.prUrl}>
            {a.prUrl.replace(/^https:\/\/github\.com\//, '')}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      title: 'Created',
      field: 'createdAt',
      render: a => new Date(a.createdAt).toLocaleString(),
    },
  ];

  if (agents.error) return <ErrorPanel error={agents.error} />;
  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <FormControl size="small" style={{ minWidth: 160 }}>
          <InputLabel id="status-filter">Status</InputLabel>
          <Select
            labelId="status-filter"
            value={status}
            onChange={e => setStatus(e.target.value as AgentStatus | '')}
          >
            <MenuItem value="">All</MenuItem>
            {AGENT_STATUSES.map(s => (
              <MenuItem key={s} value={s}>
                {s.replace('_', ' ')}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained"
          color="primary"
          component={RouterLink}
          to={`${base}/new`}
        >
          New agent
        </Button>
      </div>
      <Table<Agent>
        title="Agents"
        isLoading={agents.loading && !agents.value}
        columns={columns}
        data={agents.value ?? []}
        options={{ paging: false, search: false, padding: 'dense' }}
        emptyContent={<div style={{ padding: 16 }}>No agents yet.</div>}
      />
    </>
  );
}
