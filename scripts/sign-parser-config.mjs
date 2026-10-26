#!/usr/bin/env node
/**
 * Sign the remote parser config for release (R-32b).
 *
 * The app only applies `parser-config.json` when `parser-config.json.sig`
 * verifies against the key baked into the binary, so the sidecar is not
 * optional. `tauri signer sign` writes it in the exact shape the updater and
 * `remote_config.rs` both expect (base64 of the four-line minisign document).
 *
 * Usage:
 *   TAURI_SIGNING_PRIVATE_KEY_PATH=path/to/placemill.key \
 *   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... \
 *   node scripts/sign-parser-config.mjs path/to/parser-config.json
 *
 * Deploy the JSON and the `.sig` together. A body without a signature is
 * rejected (fail closed), so uploading the JSON first would take remote
 * configuration offline until the sidecar lands.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

function fail(message) {
  console.error(`[sign-config] ${message}`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  fail('usage: node scripts/sign-parser-config.mjs <parser-config.json>');
}
if (!existsSync(file)) {
  fail(`not found: ${file}`);
}

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
if (!keyPath) {
  // The updater signing key doubles as the config signing key; one key, one
  // rotation story.
  fail('TAURI_SIGNING_PRIVATE_KEY_PATH is not set (same key the release build uses)');
}

// The password is deliberately not passed as `-p`: the CLI reads
// `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` itself, while an argument would show up
// in the process list for as long as the signing runs.
const args = ['tauri', 'signer', 'sign', '-f', keyPath, file];

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = spawnSync(npx, args, { stdio: 'inherit' });
if (run.error) {
  fail(`could not run the Tauri CLI: ${run.error.message}`);
}
if (run.status !== 0) {
  fail(`tauri signer exited with ${run.status}`);
}

const signaturePath = `${file}.sig`;
if (!existsSync(signaturePath)) {
  fail(`tauri signer produced no ${signaturePath}`);
}

const size = statSync(signaturePath).size;
const head = readFileSync(signaturePath, 'utf8').trim().slice(0, 24);
console.log(`[sign-config] signed    ${file}`);
console.log(`[sign-config] sidecar   ${signaturePath} (${size} bytes, ${head}…)`);
console.log('[sign-config] deploy   upload BOTH files; the app rejects an unsigned body');
