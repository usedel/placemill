import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import App from './App';
import './App.css';
import { applyThemeAttribute, buildTheme, resolveDark, useResolvedDark } from './theme';
import { LocaleProvider, useI18n } from './i18n';
import { ANTD_LOCALE } from './i18n/locales';
import { SettingsBoundary } from './settings/SettingsBoundary';
import { SettingsProvider, useSettings } from './settings/SettingsContext';

// Antd's default 8 px puts toasts on top of `.brand-bar`, i.e. over the
// view switch — the control a user reaches for right after a toast like
// "cleared" lands. Drop them below the header instead of over it.
const TOAST_TOP = 64;

// Runs at module scope, i.e. before the first React render. The palette is not
// in the stylesheet: `applyThemeAttribute` writes `src/design/tokens.ts` onto
// `<html>` as custom properties, and every rule in `App.css` reads `var(--…)`.
// So this must run unconditionally — the bootstrap cache only exists inside
// Tauri, and a browser-only `npm run dev` would otherwise leave the whole panel
// without colours. The marker makes that ordering observable for the
// acceptance test.
const bootstrapSettings = window.__PLACE_MILL_SETTINGS__;
applyThemeAttribute(resolveDark(bootstrapSettings?.theme ?? 'system'));
window.__PLACE_MILL_THEME_APPLIED__ = 'module';

function Root() {
  const { settings } = useSettings();
  const { locale, setLocale } = useI18n();
  const dark = useResolvedDark(settings.theme);

  // One-way sync: Rust owns the value, the panel follows. `setLocale` still
  // mirrors into localStorage so `readStoredLocale()` keeps working as the
  // bootstrap cache. The settings drawer is the only place that can change it.
  useEffect(() => {
    if (settings.language !== locale) setLocale(settings.language);
  }, [settings.language, locale, setLocale]);

  useEffect(() => {
    applyThemeAttribute(dark);
  }, [dark]);

  return (
    <ConfigProvider locale={ANTD_LOCALE[locale]} theme={buildTheme(dark)}>
      <AntdApp message={{ top: TOAST_TOP }}>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsBoundary>
      <SettingsProvider>
        <LocaleProvider>
          <Root />
        </LocaleProvider>
      </SettingsProvider>
    </SettingsBoundary>
  </React.StrictMode>,
);
