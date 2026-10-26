#!/usr/bin/env node
/**
 * Smoke test for the placemill MCP server / CLI (G-21).
 *
 * Builds a throwaway SQLite database with the app's v5 schema, seeds a few
 * rows, then exercises the ONE script behind both shapes:
 *
 *   1. MCP stdio transport: initialize → tools/list (5 tools) → tools/call
 *      for stats / query_businesses / get_business / list_reviews, plus the
 *      error paths (unknown method → -32601, unknown tool → isError result);
 *   2. CLI: stats / query / get / reviews / export (jsonl + csv written to a
 *      temp dir);
 *   3. the read-only guarantee: a readOnly connection refuses an INSERT.
 *
 * Run: node scripts/e2e/mcp-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = join(process.cwd(), 'skills', 'placemill-leads', 'scripts', 'placemill-mcp.mjs');

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  [' + String(detail).slice(0, 300) + ']'));
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// Fixture: the v5 schema, the shape open_with_recovery/migrations produce.
// ---------------------------------------------------------------------------
function buildFixture(dir) {
  const dbPath = join(dir, 'placemill.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT, source_query TEXT DEFAULT '',
      place_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      rating REAL DEFAULT 0,
      reviews_total INTEGER DEFAULT 0,
      lat REAL DEFAULT 0,
      lng REAL DEFAULT 0,
      website TEXT DEFAULT '',
      types TEXT DEFAULT '[]',
      collected_at INTEGER DEFAULT 0,
      emails TEXT DEFAULT '[]',
      socials TEXT DEFAULT '[]',
      email_source_url TEXT DEFAULT '',
      email_status TEXT DEFAULT '',
      mined_at INTEGER DEFAULT 0,
      street TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT '',
      postal_code TEXT DEFAULT '',
      country TEXT DEFAULT '',
      borough TEXT DEFAULT '',
      timezone TEXT DEFAULT '',
      data_id TEXT DEFAULT '',
      reviews_link TEXT DEFAULT '',
      thumbnail TEXT DEFAULT '',
      owner_name TEXT DEFAULT '',
      about TEXT DEFAULT '[]',
      open_hours TEXT DEFAULT '[]',
      plus_code TEXT DEFAULT '',
      description TEXT DEFAULT '',
      reviews_per_rating TEXT DEFAULT '[]',
      photos TEXT DEFAULT '[]'
    );
    CREATE TABLE business_reviews (
      review_id             TEXT PRIMARY KEY,
      place_id              TEXT NOT NULL,
      payload_place_id      TEXT,
      author                TEXT,
      author_avatar         TEXT,
      author_id             TEXT,
      author_link           TEXT,
      stars                 INTEGER,
      text                  TEXT,
      created_at_us         INTEGER,
      updated_at_us         INTEGER,
      relative_time         TEXT,
      owner_reply           TEXT,
      owner_reply_at_us     INTEGER,
      owner_reply_relative  TEXT,
      helpful_votes         INTEGER,
      photo_url             TEXT,
      report_url            TEXT,
      channel               TEXT,
      fetched_at            INTEGER
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '5');
  `);
  const insert = db.prepare(
    `INSERT INTO businesses (place_id, name, address, phone, rating, reviews_total, website, types,
        source_query, collected_at, emails, email_status, city, plus_code, description,
        reviews_per_rating, photos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'ChIJdentist', 'Smile Dental', '281 Columbia Ave', '+14155550123', 4.8, 312,
    'https://smiledental.example', '["Dentist","Cosmetic dentist"]', 'dentist San Jose',
    1_772_000_000_000, '["info@smiledental.example"]', 'found', 'San Jose',
    '74GC+2V San Jose', 'A welcoming dental clinic.',
    '[10,20,40,80,162]', '[]',
  );
  insert.run(
    'ChIJcafe', 'Best Coffee', '695 Coleman Ave', '', 3.7, 629,
    'https://bestcoffee.example', '["Coffee shop"]', 'coffee San Jose',
    1_772_100_000_000, '[]', '', 'San Jose', '', '', '[]', '[]',
  );
  insert.run(
    'ChIJbare', 'Bare Auto', '1 Some Rd', '', 0, 0,
    '', '[]', 'auto repair', 0, '[]', '', '', '', '', '[]', '[]',
  );
  // 101 bulk rows: the export cap (1000) must NOT be the query cap (100).
  for (let i = 0; i < 101; i++) {
    insert.run(
      `ChIJbulk${i}`, `Bulk ${i}`, '', '', 0, 0,
      '', '[]', 'bulk', 0, '[]', '', '', '', '', '[]', '[]',
    );
  }
  const review = db.prepare(
    `INSERT INTO business_reviews (review_id, place_id, author, stars, text, created_at_us,
        relative_time, helpful_votes, channel, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  review.run('r1', 'ChIJdentist', 'Dawei Wang', 1, 'Not friendly.', 1_567_179_139_665_570, '7 年前', 3, 'rpc', 1_772_033_845_093);
  review.run('r2', 'ChIJdentist', 'Ana', 5, 'Great care.', 1_700_000_000_000_000, 'a year ago', 1, 'rpc', 1_772_033_845_093);
  db.close();
  return dbPath;
}

// ---------------------------------------------------------------------------
// MCP client over stdio (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------
function startServer(dbPath) {
  const child = spawn(process.execPath, [SCRIPT, '--mcp', '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const request = (method, params) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`timeout waiting for ${method}`));
      }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  // Notifications carry no id and get no reply — fire and forget.
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  return { child, request, notify, stop: () => child.kill() };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'placemill-mcp-'));
let server;
try {
  const dbPath = buildFixture(dir);

  // ---- 1. MCP transport ----------------------------------------------------
  server = startServer(dbPath);
  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  check(
    'MCP: initialize negotiates protocol + serverInfo',
    init.result &&
      init.result.protocolVersion === '2025-06-18' &&
      init.result.serverInfo.name === 'placemill',
    JSON.stringify(init).slice(0, 200),
  );
  await server.notify('notifications/initialized', {});
  const list = await server.request('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name);
  check(
    'MCP: tools/list carries the 5 tools with schemas',
    JSON.stringify(names) ===
      JSON.stringify(['stats', 'query_businesses', 'get_business', 'list_reviews', 'export']) &&
      list.result.tools.every((t) => t.inputSchema && t.description),
    JSON.stringify(names),
  );

  const call = async (name, args) => {
    const response = await server.request('tools/call', { name, arguments: args });
    const text = response.result && response.result.content && response.result.content[0].text;
    let value = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = text; // an isError message is plain text, not JSON
    }
    return {
      isError: Boolean(response.result && response.result.isError),
      value,
    };
  };

  const stats = await call('stats', {});
  check(
    'MCP: stats counts rows and ratios',
    !stats.isError &&
      stats.value.total === 104 &&
      stats.value.with_phone === 1 &&
      stats.value.with_website === 2 &&
      stats.value.with_email === 1 &&
      stats.value.review_rows === 2 &&
      Array.isArray(stats.value.top_categories) &&
      stats.value.top_categories[0].label === 'Dentist',
    JSON.stringify(stats.value).slice(0, 200),
  );

  const query = await call('query_businesses', { category: 'dentist', min_rating: 4, has_phone: true });
  check(
    'MCP: query filters by category + rating + phone and shapes JSON columns',
    !query.isError &&
      query.value.matched === 1 &&
      query.value.rows[0].place_id === 'ChIJdentist' &&
      Array.isArray(query.value.rows[0].types) &&
      query.value.rows[0].types[0] === 'Dentist' &&
      Array.isArray(query.value.rows[0].reviews_per_rating) &&
      query.value.rows[0].reviews_per_rating[4] === 162,
    JSON.stringify(query.value).slice(0, 260),
  );

  const empty = await call('query_businesses', { q: 'zzz-no-such-row' });
  check('MCP: query with no matches returns matched=0', !empty.isError && empty.value.matched === 0, JSON.stringify(empty.value));

  const got = await call('get_business', { place_id: 'ChIJdentist' });
  check(
    'MCP: get_business returns the full machine-key row',
    !got.isError &&
      got.value.plus_code === '74GC+2V San Jose' &&
      got.value.emails[0] === 'info@smiledental.example' &&
      got.value.description === 'A welcoming dental clinic.',
    JSON.stringify(got.value).slice(0, 200),
  );

  const reviews = await call('list_reviews', { place_id: 'ChIJdentist' });
  check(
    'MCP: list_reviews orders newest first (2023 review before the 2019 one)',
    !reviews.isError &&
      reviews.value.reviews.length === 2 &&
      reviews.value.reviews[0].author === 'Ana' &&
      reviews.value.reviews[0].created_at_us > reviews.value.reviews[1].created_at_us,
    JSON.stringify(reviews.value).slice(0, 200),
  );

  const unknownMethod = await server.request('no/such/method', {});
  check('MCP: unknown method is -32601', unknownMethod.error && unknownMethod.error.code === -32601, JSON.stringify(unknownMethod));
  const unknownTool = await call('no_such_tool', {});
  check('MCP: unknown tool is an isError result, not a crash', unknownTool.isError, JSON.stringify(unknownTool));

  // ---- 2. CLI ---------------------------------------------------------------
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const cli = async (...args) => JSON.parse((await run(process.execPath, [SCRIPT, ...args, '--db', dbPath])).stdout);

  const cliStats = await cli('stats');
  check('CLI: stats works', cliStats.total === 104, JSON.stringify(cliStats).slice(0, 120));
  const cliQuery = await cli('query', '--category', 'coffee', '--limit', '5');
  check('CLI: query parses flags into tool args', cliQuery.matched === 1 && cliQuery.rows[0].place_id === 'ChIJcafe', JSON.stringify(cliQuery).slice(0, 160));
  const cliGet = await cli('get', '--place-id', 'ChIJcafe');
  check('CLI: get works (kebab flag --place-id)', cliGet.name === 'Best Coffee', JSON.stringify(cliGet).slice(0, 120));

  const outJsonl = join(dir, 'out.jsonl');
  const cliExport = await cli('export', '--format', 'jsonl', '--out', outJsonl, '--has-phone');
  const jsonlBody = readFileSync(outJsonl, 'utf8').trim().split('\n');
  check(
    'CLI: export writes JSONL with one machine-key row',
    cliExport.written === 1 &&
      jsonlBody.length === 1 &&
      JSON.parse(jsonlBody[0]).place_id === 'ChIJdentist',
    JSON.stringify(cliExport).slice(0, 140),
  );
  const outCsv = join(dir, 'out.csv');
  await cli('export', '--format', 'csv', '--out', outCsv, '--category', 'coffee');
  const csvHead = readFileSync(outCsv, 'utf8').split('\r\n')[0];
  check(
    'CLI: export writes CSV with a machine-key header',
    existsSync(outCsv) && csvHead.startsWith('place_id,name,address,phone'),
    csvHead.slice(0, 120),
  );
  const outBulk = join(dir, 'bulk.jsonl');
  const bulkExport = await cli(
    'export', '--format', 'jsonl', '--out', outBulk, '--source-query', 'bulk', '--limit', '1000',
  );
  check(
    'CLI: export honours its own 1000-row cap (101 bulk rows survive the limit)',
    bulkExport.written === 101,
    'written=' + bulkExport.written,
  );
  let refused = '';
  try {
    await cli('export', '--format', 'jsonl', '--out', 'relative.jsonl');
  } catch (error) {
    refused = String(error.stderr || error.message || error);
  }
  check(
    'CLI: export refuses a relative path (exit 1 + stderr)',
    refused.includes('absolute path'),
    refused.slice(0, 140),
  );

  // ---- 3. the read-only guarantee ------------------------------------------
  let writeThrew = null;
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    ro.prepare("INSERT INTO businesses (place_id, name) VALUES ('x', 'x')").run();
  } catch (error) {
    writeThrew = error;
  }
  ro.close();
  check('Read-only: an INSERT on the readOnly connection is refused', Boolean(writeThrew), String(writeThrew));
} catch (error) {
  checks++;
  failures++;
  console.log('FAIL  smoke aborted: ' + (error && error.stack ? error.stack : error));
} finally {
  if (server) server.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
}
console.log(`\nRESULT: ${failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' FAILED / ' + checks}`);
process.exit(failures === 0 ? 0 : 1);
