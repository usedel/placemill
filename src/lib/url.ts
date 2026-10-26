/**
 * Scraped links are attacker-controlled (R-24).
 *
 * `website` and `socials` come straight out of Google Maps' payload, which is
 * itself whatever the listed business put on its profile. Rendering such a
 * value into an `href` or handing it to `window.open` executes `javascript:`
 * and `data:` URLs inside this webview — the panel has Tauri IPC, so that is a
 * full app compromise, not a stray popup.
 *
 * Every link that reaches the DOM therefore goes through `safeHttpUrl`, which
 * only ever returns an absolute `http:`/`https:` URL.
 */

/** Protocols that may be clicked. Everything else degrades to plain text. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** `scheme:` prefix, e.g. `javascript:`, `data:`, `https:`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A bare host (`example.com/path`), the shape Google sometimes returns. */
const BARE_HOST = /^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/;

/**
 * Normalise one scraped URL, or `null` when it must not be a link.
 *
 * Accepted: absolute `http(s)` URLs and bare hosts (upgraded to `https`).
 * Rejected: every other scheme, protocol-relative URLs, and anything that does
 * not parse — all of them keep rendering as text.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  let candidate: string;
  if (HAS_SCHEME.test(text)) {
    candidate = text;
  } else if (BARE_HOST.test(text)) {
    candidate = `https://${text}`;
  } else {
    return null;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname) return null;
  return url.toString();
}

/** The text a link should show: the host for a usable URL, else the raw value. */
export function linkLabel(raw: string | null | undefined, safe: string | null): string {
  const text = (raw ?? '').trim();
  if (!safe) return text;
  try {
    return new URL(safe).hostname.replace(/^www\./, '');
  } catch {
    return text;
  }
}
