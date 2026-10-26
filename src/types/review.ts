/** One stored review (M9). Mirrors Rust's `db::ReviewRow` — snake_case, the
 * same wire convention as the business-data payload (no camelCase rename on
 * the Rust side; the injected script emits these keys verbatim). */
export interface Review {
  review_id: string;
  place_id: string;
  payload_place_id: string;
  author: string;
  author_avatar: string;
  author_id: string;
  author_link: string;
  stars: number;
  text: string;
  created_at_us: number;
  updated_at_us: number;
  relative_time: string;
  owner_reply: string;
  owner_reply_at_us: number;
  owner_reply_relative: string;
  helpful_votes: number;
  photo_url: string;
  report_url: string;
  /** Which channel served it: state_cache, reviews_link or qv9Egd. */
  channel: string;
  fetched_at: number;
}