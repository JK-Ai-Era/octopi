import { useEffect, useState } from 'react';
import ChatWorkspace from './components/ChatWorkspace';
import { KnowledgeAdminPanel } from './components/KnowledgeAdminPanel';
import { PrivilegedBadge } from './components/PrivilegedBadge';
import { KnowledgeServiceStatus } from './components/KnowledgeServiceStatus';
import { SettingsWorkspace, type SettingsTab } from './components/SettingsWorkspace';
import { ThemeToggle, initTheme } from './components/ThemeToggle';
import { OnboardingWizard } from './components/OnboardingWizard';
import { resolveDefaultBase } from './gateway-base';
import { LoginPage } from './components/LoginPage';
import { requiresLogin } from './runtime-config';
import { getRegistryToken } from './console-key';

initTheme(); // 恢复持久化主题偏好（§5d：prefers-color-scheme 跟随 + 手动切换）

type Surface = 'playground' | 'knowledge' | 'settings';

export default function App() {
  // §5b：Focus = 右边栏显隐（默认隐藏 = 产品面第一印象纯对话）
  const [rightPanelVisible, setRightPanelVisible] = useState(() => {
    try {
      return localStorage.getItem('octopi.rightPanel.visible') === '1';
    } catch {
      return false;
    }
  });
  const [surface, setSurface] = useState<Surface>('playground');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('models');
  // 设置深链（#settings / #settings-services）：左栏连接条「设置 →」入口。
  // hashchange 监听 + 消费后清 hash——已加载页点击即跳；点回 Playground 后刷新不回跳（打磨批 B2/NIT-9）。
  useEffect(() => {
    const apply = (): void => {
      const h = window.location.hash;
      if (!h.startsWith('#settings')) return;
      setSurface('settings');
      setSettingsTab(h === '#settings-services' ? 'services' : 'models');
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
  const [agentId, setAgentId] = useState('default');
  // §1/§7：Web 向导入口——URL 带 setup 参数（token 见 §7）或首启（providers 未配置）检测
  // m4：②③模式需 registry 登录（personal 免登录）
  const [loggedIn, setLoggedIn] = useState(() => !requiresLogin() || Boolean(getRegistryToken()));
  const hasSetupParam = new URLSearchParams(window.location.search).has('setup');
  const [wizardDue, setWizardDue] = useState(hasSetupParam);
  useEffect(() => {
    if (hasSetupParam) return;
    fetch(`${resolveDefaultBase()}/api/v1/onboarding/availability`)
      .then((r) => r.json() as Promise<{ ok: boolean; data?: { available: boolean } }>)
      .then((b) => { if (b.data?.available) setWizardDue(true); })
      .catch(() => { /* gateway 未起/未装配向导面：走正常控制台 */ });
  }, [hasSetupParam]);
  if (!hasSetupParam && !loggedIn) {
    return (
      <div className="app-shell">
        <LoginPage onLoggedIn={() => setLoggedIn(true)} />
      </div>
    );
  }
  if (wizardDue) {
    return (
      <div className="app-shell">
        <OnboardingWizard
          onDone={() => {
            setWizardDue(false);
            // 清掉 URL 里的 setup token（一次性语义的前端收尾）
            window.history.replaceState({}, '', window.location.pathname);
          }}
        />
      </div>
    );
  }

  const toggleRightPanel = (): void => {
    setRightPanelVisible((v) => {
      try {
        localStorage.setItem('octopi.rightPanel.visible', v ? '0' : '1');
      } catch {
        // 存储不可用：本次会话生效
      }
      return !v;
    });
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <strong>Octopi Web</strong>
          <nav className="app-nav">
            <button
              type="button"
              className={surface === 'playground' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('playground')}
            >
              Playground
            </button>
            <button
              type="button"
              className={surface === 'knowledge' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('knowledge')}
            >
              Knowledge
            </button>
            <button
              type="button"
              className={surface === 'settings' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('settings')}
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="app-header-actions">
          {/* ops P4 §8.1：常驻 PRIVILEGED 标记（非一次性 toast） */}
          <PrivilegedBadge />
          {/* 自愈可见性（v0.98.14）：知识服务生命周期常驻标记，正常时零占位 */}
          <KnowledgeServiceStatus />
          <ThemeToggle />
          {surface === 'playground' && (
            <button
              type="button"
              className={rightPanelVisible ? 'btn-secondary small btn-focus-active' : 'btn-ghost small'}
              onClick={toggleRightPanel}
              title="显示/隐藏右侧面板（会话物料 · 工作进度 · 环境；专家模式含运行时透明）"
              aria-pressed={rightPanelVisible}
            >
              面板
            </button>
          )}
        </div>
      </header>
      {surface === 'playground' ? (
        <ChatWorkspace
          rightPanelVisible={rightPanelVisible}
          onAgentIdChange={setAgentId}
        />
      ) : surface === 'knowledge' ? (
        <KnowledgeAdminPanel agentId={agentId || 'default'} />
      ) : (
        <SettingsWorkspace key={settingsTab} initialTab={settingsTab} />
      )}
    </div>
  );
}
