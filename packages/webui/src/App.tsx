import { useEffect, useState } from 'react';
import { useT } from './i18n/react';
import ChatWorkspace from './components/ChatWorkspace';
import { KnowledgeAdminPanel } from './components/KnowledgeAdminPanel';
import { PrivilegedBadge } from './components/PrivilegedBadge';
import { KnowledgeServiceStatus } from './components/KnowledgeServiceStatus';
import { SettingsWorkspace, type SettingsTab } from './components/SettingsWorkspace';
import { ThemeToggle, initTheme } from './components/ThemeToggle';
import { LanguageToggle } from './components/LanguageToggle';
import { OnboardingWizard } from './components/OnboardingWizard';
import { resolveDefaultBase } from './gateway-base';
import { LoginPage } from './components/LoginPage';
import { AccessKeyGate } from './components/AccessKeyGate';
import { requiresLogin } from './runtime-config';
import { getConsoleKey, getRegistryToken } from './console-key';
import {
  type CredentialGate,
  getCredentialGate,
  installAuthFailureHandler,
  onCredentialGateChange,
  resetCredentialGate,
  submitConsoleKey,
} from './auth-guard';

initTheme(); // 恢复持久化主题偏好（§5d：prefers-color-scheme 跟随 + 手动切换）

type Surface = 'playground' | 'knowledge' | 'settings';

export default function App() {
  const t = useT();
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
  // hashchange 监听 + 消费后清 hash——已加载页点击即跳；点回 Playground 后刷新不回跳（收敛批 B2/NIT-9）。
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
  // 凭据闸：网关明确拒掉陈旧 apiKey/registryToken 后，auth-guard 切闸
  // —— ②③回登录页（login）、个人模式回填钥页（key），不再死循环「正在重连」
  const [credentialGate, setCredentialGate] = useState<CredentialGate>(getCredentialGate);
  useEffect(() => {
    const uninstall = installAuthFailureHandler();
    const offGate = onCredentialGateChange(setCredentialGate);
    return () => {
      offGate();
      uninstall();
    };
  }, []);
  const hasSetupParam = new URLSearchParams(window.location.search).has('setup');
  const [wizardDue, setWizardDue] = useState(hasSetupParam);
  useEffect(() => {
    if (hasSetupParam) return;
    // 向导面已取消 loopback 免闸（本机任意网页不得借 127.0.0.1 写配置），
    // 因此这条探测必须带令牌：控制台钥匙（本机由 serve-webui 自动下发）。
    // 无钥匙时探测 401，被 catch 吞掉 → 走正常控制台，不会误弹向导。
    const key = getConsoleKey();
    fetch(`${resolveDefaultBase()}/api/v1/onboarding/availability`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    })
      .then((r) => r.json() as Promise<{ ok: boolean; data?: { available: boolean } }>)
      .then((b) => { if (b.data?.available) setWizardDue(true); })
      .catch(() => { /* gateway 未起/未装配向导面/无钥匙：走正常控制台 */ });
  }, [hasSetupParam]);
  if (!hasSetupParam && (!loggedIn || credentialGate === 'login')) {
    return (
      <div className="app-shell">
        <LoginPage
          onLoggedIn={() => {
            resetCredentialGate();
            setLoggedIn(true);
          }}
        />
      </div>
    );
  }
  if (!hasSetupParam && credentialGate === 'key') {
    return (
      <div className="app-shell">
        <AccessKeyGate onSubmit={submitConsoleKey} />
      </div>
    );
  }
  if (wizardDue) {
    return (
      // 向导页不套 app-shell（它是 height:100vh + overflow:hidden 的聊天外壳）：
      // 套上会把超长的第 3/4 步内容裁掉且无法滚动——用可滚动的 wizard-shell。
      <div className="wizard-shell">
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
              {t('app.navPlayground')}
            </button>
            <button
              type="button"
              className={surface === 'knowledge' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('knowledge')}
            >
              {t('app.navKnowledge')}
            </button>
            <button
              type="button"
              className={surface === 'settings' ? 'btn-tab btn-tab-active' : 'btn-ghost'}
              onClick={() => setSurface('settings')}
            >
              {t('app.navSettings')}
            </button>
          </nav>
        </div>
        <div className="app-header-actions">
          {/* ops P4 §8.1：常驻 PRIVILEGED 标记（非一次性 toast） */}
          <PrivilegedBadge />
          {/* 自愈可见性（v0.98.14）：知识服务生命周期常驻标记，正常时零占位 */}
          <KnowledgeServiceStatus />
          <LanguageToggle />
          <ThemeToggle />
          {surface === 'playground' && (
            <button
              type="button"
              className={rightPanelVisible ? 'btn-secondary small btn-focus-active' : 'btn-ghost small'}
              onClick={toggleRightPanel}
              title={t('app.panelToggleTitle')}
              aria-pressed={rightPanelVisible}
            >
              {t('app.panelToggle')}
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
