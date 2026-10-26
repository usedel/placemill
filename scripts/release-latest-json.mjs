#!/usr/bin/env node
/**
 * Generate the static update manifest (`latest.json`) for a finished bundle.
 *
 * The Tauri updater downloads this JSON from the endpoint configured in
 * `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`). It must list the
 * installer for the running platform together with the minisign signature the
 * bundler produced next to it — without a matching signature the plugin
 * refuses the download.
 *
 * Usage:
 *   node scripts/release-latest-json.mjs [--tag v0.1.1] [--out <path>]
 *                                       [--notes <file.md>] [--pub-date <iso>]
 *
 *   --tag       release tag; the asset URLs become
 *               https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
 *               (owner/repo are parsed from the configured endpoint). Defaults
 *               to `v<version>` from tauri.conf.json.
 *   --out       output path; defaults to <bundleDir>/latest.json
 *   --notes     release notes file; its text becomes the manifest "notes"
 *   --pub-date  ISO timestamp; defaults to now
 *
 * NSIS is preferred when both NSIS and MSI bundles exist: the updater installs
 * it in passive mode without a UAC prompt. Build the target you actually ship.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function fail(message) {
  console.error(`[release:manifest] ${message}`);
  process.exit(1);
}

// ---- Inputs -------------------------------------------------------------

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
const tag = arg('tag', `v${version}`);

const endpoints = conf.plugins?.updater?.endpoints ?? [];
if (endpoints.length !== 1) {
  fail(`expected exactly one updater endpoint in tauri.conf.json, got ${endpoints.length}`);
}
// .../repos/<owner>/<repo>/releases/latest/download/latest.json — the API-shaped
// form GitHub also accepts for the static file.
const repoMatch = endpoints[0].match(/github\.com\/([^/]+)\/([^/]+)\/releases/);
if (!repoMatch) {
  fail(`cannot parse owner/repo from updater endpoint: ${endpoints[0]}`);
}
const [, owner, repo] = repoMatch;
const assetBase = `https://github.com/${owner}/${repo}/releases/download/${tag}`;

const bundleDir = join(root, 'src-tauri/target/release/bundle');
if (!existsSync(bundleDir)) {
  fail(`no bundle directory at ${bundleDir} — run a release build first`);
}

/** Newest match of a glob-free name pattern inside a bundle subdirectory. */
function findNewest(subdir, prefix, suffix) {
  const dir = join(bundleDir, subdir);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => ({ name, path: join(dir, name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
  return candidates[0] ?? null;
}

const nsis = findNewest('nsis', `${conf.productName}_`, '-setup.exe');
const msi = findNewest('msi', `${conf.productName}_`, '.msi');
const chosen = nsis ?? msi;
if (!chosen) {
  fail(`no signed installer found under ${bundleDir} (looked for NSIS setup.exe, then MSI)`);
}

const signaturePath = `${chosen.path}.sig`;
if (!existsSync(signaturePath)) {
  fail(
    `${chosen.name} has no .sig sidecar — the bundle was built without a signing key.\n` +
      'Set TAURI_SIGNING_PRIVATE_KEY_PATH (and _PASSWORD) before building, see README.',
  );
}
const signature = readFileSync(signaturePath, 'utf8').trim();

// ---- Manifest -----------------------------------------------------------

const notesFile = arg('notes');
const pubDate = arg('pub-date', new Date().toISOString());
const manifest = {
  version,
  notes: notesFile ? readFileSync(notesFile, 'utf8').trim() : `PlaceMill ${tag}`,
  pub_date: pubDate,
  platforms: {
    // The updater resolves the platform from the running target; a Windows
    // build only ever looks up this key.
    'windows-x86_64': {
      signature,
      // Spaces in "PlaceMill_..._setup.exe" must be percent-encoded.
      url: `${assetBase}/${encodeURIComponent(chosen.name)}`,
    },
  },
};

const outPath = arg('out', join(bundleDir, 'latest.json'));
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`[release:manifest] version      ${version} (tag ${tag})`);
console.log(`[release:manifest] installer    ${chosen.name}${nsis ? ' (nsis)' : ' (msi)'}`);
console.log(`[release:manifest] signature    ${signature.slice(0, 24)}…`);
console.log(`[release:manifest] written      ${outPath}`);
console.log('[release:manifest] upload latest.json + the installer to the GitHub release');
