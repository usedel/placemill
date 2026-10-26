import { check } from '@tauri-apps/plugin-updater';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';

/**
 * Auto-update (G-06, updater half).
 *
 * The plugin does the protocol work in Rust (endpoint fetch, minisign verify,
 * download, install); this module only translates its callback events into
 * something a progress bar can show. Keeping it free of React and antd means
 * the flow can be driven from anywhere in the panel.
 *
 * Signing: bundles are only accepted when they were signed with the private
 * half of the key whose public half sits in `tauri.conf.json` — see
 * `scripts/release-latest-json.mjs` and the README release section.
 */

/** An available update plus the fields the UI shows. */
export interface UpdateOffer {
  /** The plugin's handle; `downloadAndInstall` runs on it. */
  update: Update;
  version: string;
  currentVersion: string;
  /** Release notes from `latest.json`, when the publisher wrote any. */
  body?: string;
}

/**
 * Ask the plugin whether a newer version exists. Resolves to `null` when the
 * running build is current — including the dev build, where the endpoint
 * usually 404s and the plugin reports "up to date".
 */
export async function checkForUpdate(): Promise<UpdateOffer | null> {
  const update = await check();
  if (!update) return null;
  return {
    update,
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body,
  };
}

/**
 * Download and install an offered update. `onProgress` receives an integer
 * 0–100, or `null` while the total size is unknown (the plugin reports the
 * content length only when the server sends one).
 *
 * On Windows/NSIS the install step exits and relaunches the app by itself, so
 * a resolved promise usually means the process is already going away.
 */
export async function downloadAndInstall(
  offer: UpdateOffer,
  onProgress: (percent: number | null) => void,
): Promise<void> {
  let received = 0;
  let total: number | undefined;
  await offer.update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') {
      total = event.data.contentLength;
      received = 0;
      onProgress(total ? 0 : null);
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null);
    }
  });
}
