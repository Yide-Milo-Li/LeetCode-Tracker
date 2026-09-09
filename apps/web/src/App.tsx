/**
 * Main application component.
 * Manages view routing (Catalog vs Settings), global theme, and bilingual language state.
 */
import React, { useEffect, useState } from 'react';
import { BookOpen, Settings, Sun, Moon, Laptop, CheckCircle2, Sparkles, Calendar, Trophy } from 'lucide-react';
import { DashboardView } from './components/DashboardView.tsx';
import { CatalogView } from './components/CatalogView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { ProgressWorkbench } from './components/ProgressWorkbench.tsx';
import { TodayPlanView } from './components/TodayPlanView.tsx';
import { StrategiesView } from './components/StrategiesView.tsx';
import { useDailyPlan } from './hooks/useDailyPlan.ts';
import { api } from './api.ts';
import { translations, type Language } from './i18n.ts';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'today' | 'strategies' | 'catalog' | 'practice' | 'settings'>('dashboard');
  const [lang, setLang] = useState<Language>('en');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');

  const t = translations[lang];
  const planController = useDailyPlan();

  // Initial load of preferences from API
  useEffect(() => {
    api.getSettings()
      .then((s) => {
        if (s.language) setLang(s.language);
        if (s.theme) setTheme(s.theme);
      })
      .catch((err) => {
        console.warn('Could not load preferences from backend:', err);
      });
  }, []);

  // Theme application to document.documentElement
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      // System mode
      const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (isSystemDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }
  }, [theme]);

  // Handle language change with immediate persistence
  async function handleLanguageChange(newLang: Language) {
    setLang(newLang);
    try {
      await api.updateSettings({ language: newLang });
    } catch (err) {
      console.error('Failed to save language preference:', err);
    }
  }

  // Handle theme change with immediate persistence
  async function handleThemeChange(newTheme: 'light' | 'dark' | 'system') {
    setTheme(newTheme);
    try {
      await api.updateSettings({ theme: newTheme });
    } catch (err) {
      console.error('Failed to save theme preference:', err);
    }
  }

  return (
    <div>
      {/* Header bar */}
      <header className="header-bar">
        <div className="brand-section">
          <span className="brand-icon">⚡</span>
          <div>
            <div className="brand-title">{t.appTitle}</div>
            <div className="brand-subtitle">{t.appSubtitle}</div>
          </div>
        </div>

        <div className="nav-controls">
          {/* Main Navigation Tabs */}
          <div className="nav-tabs">
            <button
              className={`nav-tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <Trophy size={16} />
              {t.navDashboard}
            </button>
            <button
              className={`nav-tab-btn ${activeTab === 'today' ? 'active' : ''}`}
              onClick={() => setActiveTab('today')}
            >
              <Sparkles size={16} />
              {t.navToday}
            </button>
            <button
              className={`nav-tab-btn ${activeTab === 'strategies' ? 'active' : ''}`}
              onClick={() => setActiveTab('strategies')}
            >
              <Calendar size={16} />
              {t.navStrategies}
            </button>
            <button
              className={`nav-tab-btn ${activeTab === 'catalog' ? 'active' : ''}`}
              onClick={() => setActiveTab('catalog')}
            >
              <BookOpen size={16} />
              {t.navCatalog}
            </button>
            <button
              className={`nav-tab-btn ${activeTab === 'practice' ? 'active' : ''}`}
              onClick={() => setActiveTab('practice')}
            >
              <CheckCircle2 size={16} />
              {t.navPractice}
            </button>
            <button
              className={`nav-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <Settings size={16} />
              {t.navSettings}
            </button>
          </div>

          {/* Quick Theme Switcher */}
          <button
            className="btn btn-outline btn-sm"
            onClick={() => {
              const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
              handleThemeChange(next);
            }}
            title={t.themeLabel}
          >
            {theme === 'light' ? <Sun size={14} /> : theme === 'dark' ? <Moon size={14} /> : <Laptop size={14} />}
          </button>

          {/* Quick Language Switcher */}
          <button
            className="btn btn-outline btn-sm"
            onClick={() => handleLanguageChange(lang === 'en' ? 'zh' : 'en')}
            title={t.langLabel}
          >
            {lang === 'en' ? '中' : 'EN'}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="container">
        {activeTab === 'dashboard' ? (
          <DashboardView
            lang={lang}
            planController={planController}
            onNavigateToToday={() => setActiveTab('today')}
            onNavigateToSettings={() => setActiveTab('settings')}
          />
        ) : activeTab === 'today' ? (
          <TodayPlanView
            lang={lang}
            planController={planController}
            onNavigateToSettings={() => setActiveTab('settings')}
            onNavigateToDashboard={() => setActiveTab('dashboard')}
          />
        ) : activeTab === 'strategies' ? (
          <StrategiesView lang={lang} />
        ) : activeTab === 'catalog' ? (
          <CatalogView lang={lang} onNavigateSettings={() => setActiveTab('settings')} />
        ) : activeTab === 'practice' ? (
          <ProgressWorkbench lang={lang} />
        ) : (
          <SettingsView
            lang={lang}
            onLanguageChange={handleLanguageChange}
            onThemeChange={handleThemeChange}
            currentTheme={theme}
          />
        )}
      </main>
    </div>
  );
};
