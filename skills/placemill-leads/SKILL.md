---
name: placemill-leads
description: >
  Query and export the local lead database collected by placemill (a Google Maps business
  scraper) on this machine: filter businesses by keyword/category/city/minimum rating/
  has phone/has website/has email, inspect details (including Plus Code, description,
  rating breakdown, photos) and reviews, and export to JSONL/CSV. Use when the user
  mentions "local lead database", "scraped businesses", "placemill data",
  "find me ... in the database", "export leads for my CRM", etc. Purely local and
  read-only, with no network access.
---

# placemill Lead Database Query

This skill does exactly one thing: **read-only** queries against the SQLite lead database
collected by the local placemill app, plus optional export of query results to JSONL/CSV
for a CRM or downstream workflow. It never scrapes new data and never touches the network.

## Privacy and read-only contract (single source of truth)

1. The database is opened with `readOnly: true` — **no tool can write to it**; `export`
   only writes to the output file explicitly specified by the caller.
2. Fully local: no network requests, no telemetry, no credentials (this tool needs none;
   **never** pass any secret on the command line).
3. The data belongs to the user, who collected it. Where it goes (e.g. uploading to a
   cloud service) is the user's call — **always ask first before exporting off the user's
   machine**.

## Database location

By default it auto-discovers `%APPDATA%\com.placemill.app\placemill.db` (Windows;
macOS `~/Library/Application Support/com.placemill.app/`; Linux `$XDG_DATA_HOME`).
Override with `--db <path>` or the `PLACE_MILL_DB` environment variable (for example,
to point at an exported copy).
If the file cannot be opened because the app holds a lock: ask the user to close
placemill, or copy the database file first and query the copy.

## Usage

Script: `scripts/placemill-mcp.mjs` (Node 22.5+, zero dependencies). Run `stats` first to
see what is in the database, then `query`, then `get` / `reviews` / `export` as needed.

```bash
# Overview: total count, contact-info coverage, average rating, top categories
node scripts/placemill-mcp.mjs stats

# Query (all filters optional; limit caps at 100, default 20)
node scripts/placemill-mcp.mjs query --category dentist --min-rating 4.5 --has-phone --limit 20
node scripts/placemill-mcp.mjs query --q "nissan" --city "San Jose" --sort reviews_desc
node scripts/placemill-mcp.mjs query --has-email --source-query "coffee San Jose"

# Full record for one business (including Tier-2 enrichment: plus_code / description / reviews_per_rating / photos)
node scripts/placemill-mcp.mjs get --place-id ChIJI7IvT70zjoARVt733pqF6Uc

# Reviews for one business (first screen captured by the app, newest first)
node scripts/placemill-mcp.mjs reviews --place-id ChIJI7IvT70zjoARVt733pqF6Uc --limit 20

# Export (out must be an absolute path; format jsonl | csv)
node scripts/placemill-mcp.mjs export --format jsonl --out "D:\leads\export.jsonl" --has-email --min-rating 4
```

## Field glossary (snake_case machine keys, matching placemill's JSON export)

`place_id` `name` `address` `phone` `rating` `reviews_total` `lat` `lng` `website`
`types[]` `source_query` `collected_at`(epoch ms) `emails[]` `socials[]`
`email_status`(found/none-found/blocked/error/empty = not mined) `street` `city` `state`
`postal_code` `country` `borough` `timezone` `data_id` `reviews_link` `thumbnail`
`owner_name` `about[{key,label}]` `open_hours[{day,periods[]}]` `plus_code`
`description` `reviews_per_rating[5]`(1★…5★) `photos[]`

## Working conventions for the agent

- **`stats` before querying**: check total volume and category distribution first, then
  build filters — this avoids empty sweeps.
- **Pagination**: `query` returns at most 100 rows per call; use `offset` to page beyond
  that, or just `export` (up to 1000 rows per call).
- **Citing results**: when showing results to the user, lead with
  `name / phone / website / rating / city`; `emails` are contact info, so list them
  verbatim but do not repeat them in unrelated context.
- **Timestamps**: `collected_at` / `mined_at` / `fetched_at` are epoch milliseconds;
  `created_at_us` is microseconds.
- **Do not promise more than the exact numbers**: report only what the database contains;
  be honest about missing columns (not enriched, email not mined).
