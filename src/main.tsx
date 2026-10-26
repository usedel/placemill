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

// Runs at module scope, i.e. before the first React render. `App.css` switches
// its design tokens on `[data-theme]`, so doing this inside an effect would show
// one frame of the light palette to dark-mode users. The marker makes that
// ordering observable for the acceptance test.
const bootstrapSettings = window.__PLACE_MILL_SETTINGS__;
if (bootstrapSettings) {
  applyThemeAttribute(resolveDark(bootstrapSettings.theme));
  window.__PLACE_MILL_THEME_APPLIED__ = 'module';
}

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
      <AntdApp>
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
