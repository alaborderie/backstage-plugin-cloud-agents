import { useEffect } from 'react';
import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useResolvedPath,
} from 'react-router-dom';
import { ButtonLink, Tab, TabList, Tabs, VisuallyHidden } from '@backstage/ui';
import { RiAddLine } from '@remixicon/react';
import { isTyping, plural } from '../format';
import { AgentsContext, BasePathContext, useAgentsSource } from '../hooks';
import { AgentDetail } from './detail/AgentDetail';
import { AgentsList } from './list/AgentsList';
import { NewAgent } from './new/NewAgent';
import { Settings } from './settings/Settings';
import { CelebrationLayer, ui } from './ui';
import styles from './Root.module.css';

function Header(props: { base: string; needsYou: number; section: string }) {
  const { base, needsYou, section } = props;
  const selected =
    section === 'new' || section === 'settings' ? section : 'agents';
  return (
    <header className={styles.head}>
      <div className={styles.headIn}>
        <div className={styles.title}>
          <div>
            <h1>Cloud agents</h1>
            <p>Coding agents that run as Kubernetes Jobs on your cluster.</p>
          </div>
          {selected !== 'new' && (
            <ButtonLink
              href={`${base}/new`}
              variant="primary"
              iconStart={<RiAddLine aria-hidden="true" />}
              className={styles.newButton}
            >
              New agent
            </ButtonLink>
          )}
        </div>
        <Tabs className={styles.tabs} selectedKey={selected}>
          <TabList aria-label="Cloud agents">
            <Tab id="agents" href={base} matchStrategy="prefix">
              Agents
              {needsYou > 0 && (
                <>
                  <span className={styles.badge} aria-hidden="true">
                    {needsYou}
                  </span>
                  <VisuallyHidden>
                    , {plural(needsYou, 'agent')} need
                    {needsYou === 1 ? 's' : ''} you
                  </VisuallyHidden>
                </>
              )}
            </Tab>
            <Tab id="new" href={`${base}/new`} matchStrategy="prefix">
              New agent
            </Tab>
            <Tab id="settings" href={`${base}/settings`} matchStrategy="prefix">
              Settings
            </Tab>
          </TabList>
        </Tabs>
      </div>
    </header>
  );
}

/** The plugin page: agents, a new agent form, an agent's detail, and settings. */
export function CloudAgentsRoot() {
  const base = useResolvedPath('.').pathname.replace(/\/$/, '');
  const location = useLocation();
  const navigate = useNavigate();
  const agents = useAgentsSource();
  const rest = location.pathname.slice(base.length);
  const section = rest.split('/')[1] ?? '';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || event.defaultPrevented) return;
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        navigate(`${base}/new`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [base, navigate]);

  return (
    <BasePathContext.Provider value={base}>
      <AgentsContext.Provider value={agents}>
        <CelebrationLayer>
          <div className={`${ui.scope} ${styles.root}`}>
            <Header base={base} needsYou={agents.needsYou} section={section} />
            <main className={styles.page}>
              <div key={section} className={ui.view}>
                <Routes>
                  <Route path="/" element={<AgentsList />} />
                  <Route path="/new" element={<NewAgent />} />
                  <Route path="/agents/:id" element={<AgentDetail />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </div>
            </main>
          </div>
        </CelebrationLayer>
      </AgentsContext.Provider>
    </BasePathContext.Provider>
  );
}
