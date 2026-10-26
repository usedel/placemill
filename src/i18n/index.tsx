import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { en, type Dict, type MessageKey } from './en';
import { es } from './es';
import { zh } from './zh';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  LOCALE_TAG,
  type Locale,
} from './locales';

// `en` (readonly literal types) is assignable to Dict, so the source dictionary
// doubles as the canonical shape check for every other locale.
const DICTS: Record<Locale, Dict> = { en, zh, es };

export type Vars = Record<string, string | number>;
export type TFunc = (key: MessageKey, vars?: Vars) => string;

/**
 * Resolve a key for a locale. A missing entry falls back to the key itself on
 * purpose: seeing `filters.ratingAll` in the UI makes an untranslated string
 * obvious, while silently returning English hides it.
 */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = DICTS[locale]?.[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in vars ? String(vars[name]) : placeholder,
  );
}

/** Synchronous bootstrap read so the first paint already uses the saved locale. */
export function readStoredLocale(): Locale {
  // 1. Settings injected by Rust before the first frame — authoritative.
  const injected = window.__PLACE_MILL_SETTINGS__?.language;
  if (injected && LOCALES.includes(injected)) return injected;

  // 2. localStorage cache: kept as a fallback for when the injected script is
  //    missing, so the panel still opens in the user's language.
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw && LOCALES.includes(raw as Locale)) return raw as Locale;
  } catch {
    /* localStorage can be unavailable — fall through to the default */
  }
  return DEFAULT_LOCALE;
}

interface Ctx {
  locale: Locale;
  /** BCP 47 tag for Intl formatting and `<html lang>`. */
  tag: string;
  t: TFunc;
  setLocale: (next: Locale) => void;
}

const I18nContext = createContext<Ctx | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = LOCALE_TAG[locale];
  }, [locale]);

  // `t` changes identity with the locale on purpose: components that memoize
  // their output have to re-render, and stale callbacks would otherwise keep
  // returning the previous language.
  const t = useCallback<TFunc>(
    (key, vars) => translate(locale, key, vars),
    [locale],
  );

  const value = useMemo<Ctx>(
    () => ({ locale, tag: LOCALE_TAG[locale], t, setLocale }),
    [locale, t, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <LocaleProvider>');
  return ctx;
}

/** Convenience hook for components that only need the translator. */
export function useT(): TFunc {
  return useI18n().t;
}

export type { Locale, MessageKey };
