#!/usr/bin/env node
/**
 * placemill MCP server + CLI — read-only access to the local leads database.
 *
 * ONE file, two shapes (single source of truth, per the gosom teardown §5.8):
 *
 *   MCP server:   node placemill-mcp.mjs --mcp
 *                 (newline-delimited JSON-RPC 2.0 over stdio; wire it into
 *                 Claude Desktop / Claude Code / CodeBuddy / Cursor — see
 *                 skills/placemill-leads/SKILL.md)
 *
 *   CLI:          node placemill-mcp.mjs stats
 *                 node placemill-mcp.mjs query [--q text] [--category text]
 *                      [--min-rating 4] [--has-phone] [--has-website]
 *                      [--has-email] [--source-query text] [--city text]
 *                      [--sort rating_desc|reviews_desc|collected_desc|name_asc]
 *                      [--limit 20] [--offset 0]
 *                 node placemill-mcp.mjs get --place-id ChIJ...
 *                 node placemill-mcp.mjs reviews --place-id ChIJ... [--limit 20]
 *                 node placemill-mcp.mjs export --format jsonl|csv --out PATH
 *                      [same filters as query]
 *
 * The Agent Skill (skills/placemill-leads/SKILL.md) drives this same file.
 *
 * Privacy contract (the one place it is stated):
 *   - the database opens READ-ONLY (`readOnly: true`) — no tool can write a
 *     single byte of it;
 *   - no network access, no telemetry: everything stays on this machine;
 *   - `export` writes ONLY the file path the caller explicitly passes.
 *
 * Zero dependencies: `node:sqlite` ships with Node 22.5+ (stable 23+). The
 * JSON keys are the same snake_case machine keys the app's JSON export uses
 * (M10) — one field-name vocabulary for agents, scripts and exports.
 */
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import process from 'node:process';
import { createInterface } from 'node:readline';

const SERVER_NAME = 'placemill';
const SERVER_VERSION = '0.1.1';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_LIMIT = 100;
/// `export` paginates differently: it writes a file, not a chat payload, so
/// its cap is 10× the query cap — the docs (tool schema, SKILL.md,
/// skills/placemill-leads/SKILL.md) all promise 1000 rows per call.
const EXPORT_MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Database location + opening (read-only)
// ---------------------------------------------------------------------------

/// The app stores its database under the OS data dir keyed by the Tauri
/// identifier (`com.placemill.app`), same place `app_data_dir()` resolves to.
function defaultDbPath() {
  const segments = join('com.placemill.app', 'placemill.db');
  if (platform() === 'win32' && env.APPDATA) return join(env.APPDATA, segments);
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', segments);
  }
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, segments);
}

function openDatabase(explicitPath) {
  const dbPath = resolve(explicitPath || defaultDbPath());
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(
      `Cannot open the leads database at ${dbPath} (${error.message}). ` +
        'Pass --db PATH, or set PLACE_MILL_DB. Hint: the database lives where ' +
        'the placemill app stores it (see skills/placemill-leads/SKILL.md); close the app ' +
        'if the file is locked.',
    );
  }
  try {
    db.exec('PRAGMA busy_timeout = 3000');
  } catch {
    /* pragma is best-effort */
  }
  return db;
}

// ---------------------------------------------------------------------------
// Row shaping — the machine-key vocabulary (M10 export_json, snake_case)
// ---------------------------------------------------------------------------

const JSON_COLUMNS = ['types', 'emails', 'socials', 'reviews_per_rating', 'photos', 'about', 'open_hours'];

function parseJsonColumn(value) {
  if (typeof value !== 'string' || value.length === 0) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    // A corrupt write must never break a whole result set — return the raw
    // string so the row still ships.
    return value;
  }
}

function shapeBusiness(row) {
  const out = { ...row };
  for (const column of JSON_COLUMNS) {
    out[column] = parseJsonColumn(out[column]);
  }
  return out;
}

function shapeReview(row) {
  return { ...row };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SORTS = {
  rating_desc: 'rating DESC, reviews_total DESC',
  reviews_desc: 'reviews_total DESC, rating DESC',
  collected_desc: 'collected_at DESC',
  name_asc: 'name COLLATE NOCASE ASC',
};

function buildFilters(args) {
  const where = [];
  const params = [];
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  if (q) {
    where.push('(name LIKE ? OR address LIKE ? OR website LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  if (category) {
    // types is a JSON array of strings; a corrupt value must not kill the
    // whole query, hence the json_valid guard.
    where.push(
      "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(businesses.types) THEN businesses.types ELSE '[]' END) je WHERE je.value LIKE ?)",
    );
    params.push(`%${category}%`);
  }
  const city = typeof args.city === 'string' ? args.city.trim() : '';
  if (city) {
    where.push('(city LIKE ? OR address LIKE ?)');
    params.push(`%${city}%`, `%${city}%`);
  }
  const source = typeof args.source_query === 'string' ? args.source_query.trim() : '';
  if (source) {
    where.push('source_query LIKE ?');
    params.push(`%${source}%`);
  }
  const minRating = Number(args.min_rating);
  if (Number.isFinite(minRating) && minRating > 0) {
    where.push('rating >= ?');
    params.push(Math.min(minRating, 5));
  }
  if (args.has_phone) where.push("TRIM(COALESCE(phone, '')) <> ''");
  if (args.has_website) where.push("TRIM(COALESCE(website, '')) <> ''");
  if (args.has_email) where.push("TRIM(COALESCE(emails, '[]')) NOT IN ('', '[]')");
  return { where, params };
}

function clampLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

const TOOLS = [
  {
    name: 'stats',
    description:
      'Overview of the local placemill leads database: row counts, contactability ratios, rating average, top categories, latest collection time. Call this first to see what the database holds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(db) {
      const one = (sql, ...params) => db.prepare(sql).get(...params);
      const total = one('SELECT COUNT(*) AS n FROM businesses').n;
      const withPhone = one(
        "SELECT COUNT(*) AS n FROM businesses WHERE TRIM(COALESCE(phone, '')) <> ''",
      ).n;
      const withWebsite = one(
        "SELECT COUNT(*) AS n FROM businesses WHERE TRIM(COALESCE(website, '')) <> ''",
      ).n;
      const withEmail = one(
        "SELECT COUNT(*) AS n FROM businesses WHERE TRIM(COALESCE(emails, '[]')) NOT IN ('', '[]')",
      ).n;
      const enriched = one(
        "SELECT COUNT(*) AS n FROM businesses WHERE TRIM(COALESCE(plus_code, '')) <> '' OR TRIM(COALESCE(description, '')) <> ''",
      ).n;
      const ratingStats = one(
        'SELECT COUNT(rating) AS rated, AVG(rating) AS avg_rating FROM businesses WHERE rating > 0',
      );
      const latest = one('SELECT MAX(collected_at) AS latest FROM businesses').latest;
      const categories = db
        .prepare(
          `SELECT je.value AS label, COUNT(*) AS count
           FROM businesses, json_each(CASE WHEN json_valid(businesses.types) THEN businesses.types ELSE '[]' END) je
           GROUP BY je.value ORDER BY count DESC LIMIT 10`,
        )
        .all();
      const reviewCount = one('SELECT COUNT(*) AS n FROM business_reviews').n;
      return {
        total,
        with_phone: withPhone,
        with_website: withWebsite,
        with_email: withEmail,
        enriched_details: enriched,
        rated: ratingStats.rated,
        avg_rating: ratingStats.avg_rating === null ? null : Math.round(ratingStats.avg_rating * 100) / 100,
        review_rows: reviewCount,
        latest_collected_at: latest,
        top_categories: categories,
      };
    },
  },
  {
    name: 'query_businesses',
    description:
      'Query collected businesses with filters. Returns full rows (snake_case machine keys, same vocabulary as the app JSON export). Use limit/offset to page; hard cap is 100 rows per call.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Substring match over name / address / website' },
        category: { type: 'string', description: 'Substring match over the type list (e.g. "dentist")' },
        city: { type: 'string', description: 'Substring match over city / address' },
        source_query: { type: 'string', description: 'The search that produced the row' },
        min_rating: { type: 'number', description: 'Minimum rating (0-5)' },
        has_phone: { type: 'boolean', description: 'Only rows with a phone number' },
        has_website: { type: 'boolean', description: 'Only rows with a website' },
        has_email: { type: 'boolean', description: 'Only rows with mined email addresses' },
        sort: {
          type: 'string',
          enum: Object.keys(SORTS),
          description: 'Order (default collected_desc = freshest first)',
        },
        limit: { type: 'number', description: 'Rows per page, 1-100 (default 20)' },
        offset: { type: 'number', description: 'Rows to skip (default 0)' },
      },
      additionalProperties: false,
    },
    run(db, args) {
      const { where, params } = buildFilters(args);
      const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const orderSql = SORTS[args.sort] || SORTS.collected_desc;
      const limit = clampLimit(args.limit);
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const matched = db
        .prepare(`SELECT COUNT(*) AS n FROM businesses${whereSql}`)
        .get(...params).n;
      const rows = db
        .prepare(
          `SELECT place_id, name, address, phone, rating, reviews_total, lat, lng, website, types,
                  source_query, collected_at, emails, socials, email_source_url, email_status, mined_at,
                  street, city, state, postal_code, country, borough, timezone, data_id, reviews_link,
                  thumbnail, owner_name, about, open_hours, plus_code, description, reviews_per_rating, photos
           FROM businesses${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
        .map(shapeBusiness);
      return { matched, returned: rows.length, limit, offset, rows };
    },
  },
  {
    name: 'get_business',
    description:
      'One business by its Google place_id (ChIJ…), every stored field including Tier-2 enrichment (plus_code, description, rating distribution, photos).',
    inputSchema: {
      type: 'object',
      properties: { place_id: { type: 'string', description: 'Google place id, ChIJ…' } },
      required: ['place_id'],
      additionalProperties: false,
    },
    run(db, args) {
      const placeId = String(args.place_id || '').trim();
      if (!placeId) throw new Error('place_id is required');
      const row = db
        .prepare(
          `SELECT place_id, name, address, phone, rating, reviews_total, lat, lng, website, types,
                  source_query, collected_at, emails, socials, email_source_url, email_status, mined_at,
                  street, city, state, postal_code, country, borough, timezone, data_id, reviews_link,
                  thumbnail, owner_name, about, open_hours, plus_code, description, reviews_per_rating, photos
           FROM businesses WHERE place_id = ?`,
        )
        .get(placeId);
      return row ? shapeBusiness(row) : { error: `no business with place_id ${placeId}` };
    },
  },
  {
    name: 'list_reviews',
    description:
      'Stored reviews for one business (first screen the app captured — the M9 scope), most recent first. Use get_business for the review totals.',
    inputSchema: {
      type: 'object',
      properties: {
        place_id: { type: 'string', description: 'Google place id, ChIJ…' },
        limit: { type: 'number', description: 'Reviews per page, 1-100 (default 20)' },
      },
      required: ['place_id'],
      additionalProperties: false,
    },
    run(db, args) {
      const placeId = String(args.place_id || '').trim();
      if (!placeId) throw new Error('place_id is required');
      const limit = clampLimit(args.limit);
      const rows = db
        .prepare(
          `SELECT review_id, place_id, author, author_avatar, author_id, author_link, stars, text,
                  created_at_us, updated_at_us, relative_time, owner_reply, owner_reply_relative,
                  helpful_votes, photo_url, channel, fetched_at
           FROM business_reviews WHERE place_id = ?
           ORDER BY COALESCE(created_at_us, 0) DESC LIMIT ?`,
        )
        .all(placeId, limit)
        .map(shapeReview);
      return { place_id: placeId, returned: rows.length, reviews: rows };
    },
  },
  {
    name: 'export',
    description:
      'Write a filtered query result to a file the caller names: JSONL (machine keys, one row per line) or CSV. The database itself is never written — only this output file.',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'Absolute output file path' },
        format: { type: 'string', enum: ['jsonl', 'csv'], description: 'Default jsonl' },
        q: { type: 'string' },
        category: { type: 'string' },
        city: { type: 'string' },
        source_query: { type: 'string' },
        min_rating: { type: 'number' },
        has_phone: { type: 'boolean' },
        has_website: { type: 'boolean' },
        has_email: { type: 'boolean' },
        sort: { type: 'string', enum: Object.keys(SORTS) },
        limit: { type: 'number', description: '1-1000 for export (default 200)' },
      },
      required: ['out'],
      additionalProperties: false,
    },
    async run(db, args) {
      const out = String(args.out || '').trim();
      if (!out) throw new Error('out (absolute file path) is required');
      if (!isAbsolute(out)) throw new Error(`out must be an absolute path, got: ${out}`);
      const format = args.format === 'csv' ? 'csv' : 'jsonl';
      const { where, params } = buildFilters(args);
      const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const orderSql = SORTS[args.sort] || SORTS.collected_desc;
      const requested = Number(args.limit);
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), EXPORT_MAX_LIMIT)
          : 200;
      const rows = db
        .prepare(
          `SELECT place_id, name, address, phone, rating, reviews_total, lat, lng, website, types,
                  source_query, collected_at, emails, socials, email_source_url, email_status, mined_at,
                  street, city, state, postal_code, country, borough, timezone, data_id, reviews_link,
                  thumbnail, owner_name, about, open_hours, plus_code, description, reviews_per_rating, photos
           FROM businesses${whereSql} ORDER BY ${orderSql} LIMIT ?`,
        )
        .all(...params, limit)
        .map(shapeBusiness);

      const columns = [
        'place_id', 'name', 'address', 'phone', 'rating', 'reviews_total', 'lat', 'lng', 'website',
        'types', 'source_query', 'collected_at', 'emails', 'socials', 'email_source_url',
        'email_status', 'mined_at', 'street', 'city', 'state', 'postal_code', 'country', 'borough',
        'timezone', 'data_id', 'reviews_link', 'thumbnail', 'owner_name', 'about', 'open_hours',
        'plus_code', 'description', 'reviews_per_rating', 'photos',
      ];
      const csvCell = (value) => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      let body;
      if (format === 'csv') {
        const lines = [columns.join(',')];
        for (const row of rows) {
          lines.push(columns.map((key) => csvCell(row[key])).join(','));
        }
        body = lines.join('\r\n') + '\r\n';
      } else {
        body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
      }
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, body, 'utf8');
      return { format, written: rows.length, out };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

function toolManifests() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function dispatchTool(db, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.run(db, args || {});
}

async function runMcpServer(db) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      replyError(null, -32700, 'parse error');
      continue;
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    try {
      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
          break;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          break; // notifications get no reply
        case 'ping':
          if (!isNotification) reply(id, {});
          break;
        case 'tools/list':
          reply(id, { tools: toolManifests() });
          break;
        case 'tools/call': {
          const name = params && params.name;
          const args = params && params.arguments;
          try {
            const result = await dispatchTool(db, String(name || ''), args);
            reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
          } catch (error) {
            // Tool-level failure: an MCP result with isError, so the agent
            // sees the message instead of a transport error.
            reply(id, {
              content: [{ type: 'text', text: String(error && error.message ? error.message : error) }],
              isError: true,
            });
          }
          break;
        }
        default:
          if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
      }
    } catch (error) {
      if (!isNotification) replyError(id, -32603, String(error && error.message ? error.message : error));
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/// CLI aliases: the skill's examples use the short verbs; the MCP tool names
/// stay the canonical vocabulary.
const CLI_ALIASES = {
  query: 'query_businesses',
  get: 'get_business',
  reviews: 'list_reviews',
};

async function runCli(command, args) {
  const db = openDatabase(args.db);
  const canonical = CLI_ALIASES[command] || command;
  const tool = TOOLS.find((t) => t.name === canonical);
  if (!tool) {
    db.close();
    throw new Error(
      `unknown command: ${command} (known: ${TOOLS.map((t) => t.name).join(', ')}, plus --mcp)`,
    );
  }
  // The CLI maps flags onto tool arguments: kebab flags (--place-id) become
  // the schema's snake_case names, booleans stay flags, everything else
  // passes through as a string/number.
  const toolArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'db' || key === 'mcp') continue;
    toolArgs[key.replace(/-/g, '_')] = value;
  }
  const result = await tool.run(db, toolArgs);
  db.close();
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseCliArgs(argv);
  if (args.mcp || argv.length === 0) {
    const db = openDatabase(args.db);
    await runMcpServer(db);
    return;
  }
  const command = argv[0];
  const result = await runCli(command, args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`[placemill-mcp] ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
