/**
 * Shared presentation for mined contacts (M7).
 *
 * The table cell and the detail drawer must agree on two things: which glyph a
 * social URL gets, and what a row's `email_status` means in words. Both used to
 * live inside one component; a second copy in the drawer would have drifted the
 * first time a status was renamed in Rust.
 */
import {
  FacebookFilled,
  GlobalOutlined,
  InstagramFilled,
  LinkedinFilled,
  XFilled,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { MessageKey } from '../i18n';

/** The platforms `email_miner.rs` classifies, plus a neutral fallback. */
type SocialPlatform = 'linkedin' | 'facebook' | 'instagram' | 'x' | 'other';

function socialPlatform(url: string): SocialPlatform {
  const lowered = url.toLowerCase();
  if (lowered.includes('linkedin.com')) return 'linkedin';
  if (lowered.includes('facebook.com') || lowered.includes('fb.com')) return 'facebook';
  if (lowered.includes('instagram.com')) return 'instagram';
  // `twitter.com` redirects to `x.com`; a profile mined before the rename keeps
  // the old host and must still get the mark.
  if (lowered.includes('x.com') || lowered.includes('twitter.com')) return 'x';
  return 'other';
}

/**
 * The official filled mark for each platform, brand-coloured by
 * `.social-glyph.is-*` in App.css (the colours live in `design/tokens.ts`).
 *
 * Filled rather than outlined on purpose: at 12–13px inside a dense table row a
 * line glyph reads as a smudge, and the brand mark is what makes the column
 * scannable. The fallback is a globe, not the X mark — the miner only extracts
 * four platforms today, but a stored `socials` row from a future release must
 * not be mislabelled as X.
 */
const PLATFORM_GLYPH: Record<SocialPlatform, ReactNode> = {
  linkedin: <LinkedinFilled />,
  facebook: <FacebookFilled />,
  instagram: <InstagramFilled />,
  x: <XFilled />,
  other: <GlobalOutlined />,
};

/** The matching social mark for a mined profile link (M7). */
export function socialIcon(url: string): ReactNode {
  const platform = socialPlatform(url);
  return <span className={`social-glyph is-${platform}`}>{PLATFORM_GLYPH[platform]}</span>;
}

/**
 * `email_status` → the message key that names the outcome in words.
 *
 * The empty string is "never mined" (`STATUS_RETRYABLE` in `email_miner.rs`),
 * which is deliberately *not* the same as "mined and found nothing": the first
 * still has a chance, the second spent a request and got an answer.
 */
export function emailStatusKey(status: string): MessageKey {
  switch (status) {
    case 'found':
      return 'contacts.status.found';
    case 'none-found':
      return 'contacts.status.noneFound';
    case 'blocked':
      return 'contacts.status.blocked';
    case 'error':
      return 'contacts.status.error';
    default:
      return 'contacts.status.unmined';
  }
}
