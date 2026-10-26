import enUS from 'antd/locale/en_US';
import esES from 'antd/locale/es_ES';
import zhCN from 'antd/locale/zh_CN';
import type { Locale as AntdLocale } from 'antd/es/locale';

/**
 * Adding a language: add its code here, add the dictionary file and register it
 * in `DICTS` inside ./index. Nothing else in the app needs to change.
 */
export const LOCALES = ['en', 'zh', 'es'] as const;

export type Locale = (typeof LOCALES)[number];

/** English is the default regardless of the OS locale. */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Bootstrap cache only. The authoritative value will live in the Rust settings
 * store once that feature lands; this keeps the first paint synchronous so the
 * UI never flashes English before switching.
 */
export const LOCALE_STORAGE_KEY = 'placemill.locale';

export const ANTD_LOCALE: Record<Locale, AntdLocale> = {
  en: enUS,
  zh: zhCN,
  es: esES,
};

/** Label shown in the language picker — always in the target language itself. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  zh: '简体中文',
  es: 'Español',
};

/** BCP 47 tag used for Intl number/date formatting and `<html lang>`. */
export const LOCALE_TAG: Record<Locale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  es: 'es-ES',
};
