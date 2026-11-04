import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useResolvedPath,
} from 'react-router-dom';
import { Content, Header, HeaderTabs, Page } from '@backstage/core-components';
import { BasePathContext } from '../hooks';
import { AgentDetail } from './AgentDetail';
import { AgentsList } from './AgentsList';
import { NewAgent } from './NewAgent';
import { Settings } from './Settings';

const TABS = [
  { id: 'agents', label: 'Agents', path: '' },
  { id: 'new', label: 'New agent', path: '/new' },
  { id: 'settings', label: 'Settings', path: '/settings' },
];

/** The plugin page: agents, a new agent form, an agent's detail, and settings. */
export function CloudAgentsRoot() {
  const base = useResolvedPath('.').pathname.replace(/\/$/, '');
  const location = useLocation();
  const navigate = useNavigate();
  const rest = location.pathname.slice(base.length);
  const selected = Math.max(
    0,
    TABS.findIndex(t => t.path && rest.startsWith(t.path)),
  );

  return (
    <BasePathContext.Provider value={base}>
      <Page themeId="tool">
        <Header
          title="Cloud agents"
          subtitle="Coding agents that run as Kubernetes Jobs"
        />
        <HeaderTabs
          tabs={TABS.map(({ id, label }) => ({ id, label }))}
          selectedIndex={selected}
          onChange={index => navigate(`${base}${TABS[index]?.path ?? ''}`)}
        />
        <Content>
          <Routes>
            <Route path="/" element={<AgentsList />} />
            <Route path="/new" element={<NewAgent />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Content>
      </Page>
    </BasePathContext.Provider>
  );
}
