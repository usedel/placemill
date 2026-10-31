export interface Business {
  name: string;
  address: string;
  phone: string;
  rating: number;
  reviews_total: number;
  lat: number;
  lng: number;
  place_id: string;
  website: string;
  types: string[];
  /** Epoch ms of the first write; `0` on rows collected before this shipped. */
  collected_at: number;
  /** Search that produced the row; empty on legacy rows. */
  source_query: string;
  /** Mined addresses (M7). Empty until the site miner ran on this row. */
  emails: string[];
  /** Mined social profile links, at most one per platform. */
  socials: string[];
  /** Page the first email was found on; empty when none. */
  email_source_url: string;
  /** '' = never mined, else found / none-found / blocked / error. */
  email_status: string;
  /** Epoch ms of the last mining pass over this row. */
  mined_at: number;
  // ===== M8 / J-08c =====
  // The fields the index probe confirmed as filled in the search payload.
  // Empty on rows collected before J-08c.
  /** Street part of the structured address. */
  street: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  borough: string;
  /** IANA time zone, e.g. "America/Los_Angeles". */
  timezone: string;
  /** Google's internal place id ("0x…:0x…") — a cross-source key. */
  data_id: string;
  /** Link to the reviews page. */
  reviews_link: string;
  /** Thumbnail image URL. */
  thumbnail: string;
  /** The owner behind the listing, without Google's role tag. */
  owner_name: string;
  /** The about block: label/value pairs ("accessibility" → "Accessibility"). */
  about: AboutEntry[];
  /** Opening hours per weekday. */
  open_hours: OpenHoursDay[];
  // ===== Tier-2 detail enrichment =====
  // Filled by the enrichment runner after a place-page visit; empty on rows
  // that were never enriched.
  /** Open Location Code, e.g. "74GC+2V San Jose, California". */
  plus_code: string;
  /** The place's own long description; business-type dependent. */
  description: string;
  /** Review counts per star, index 0 = 1-star … index 4 = 5-star. */
  reviews_per_rating: number[];
  /** Photo URLs from the detail payload, deduplicated. */
  photos: string[];
}

/** One entry of the about block (M8 / J-08c). */
export interface AboutEntry {
  key: string;
  label: string;
}

/** Opening hours for one weekday (M8 / J-08c). */
export interface OpenHoursDay {
  /** "Monday" .. "Sunday", the way Google's payload spells it. */
  day: string;
  /** The periods, e.g. ["9 AM – 5 PM"]. Empty means closed that day. */
  periods: string[];
}

/** A job that observed a business (T-02). Sidecar to `BusinessPage.rows`. */
export interface BusinessJobRef {
  placeId: string;
  jobId: string;
  name: string;
  timesSeen: number;
}

/**
 * One address of a row, with its own verdict (G-04).
 *
 * `sameDomain` is row-level evidence — the same `info@foo.com` can belong to a
 * business whose site is `bar.com` — so it is computed per row and never
 * stored with the address.
 */
export interface AddressVerification {
  address: string;
  /** `valid` | `risky` | `invalid` | `unknown` | `error` | `unverified`. */
  status: string;
  /** Stable machine tokens (`role`, `typo`, `free_mail`, …) — translated in the UI. */
  flags: string[];
  /** Epoch ms; `0` when the address was never checked. */
  checkedAt: number;
  /** The verdict exists but has expired. */
  stale: boolean;
  sameDomain: boolean;
}

/** One row's aggregated verdict (G-04). Sidecar to `BusinessPage.rows`. */
export interface BusinessVerificationRef {
  placeId: string;
  /** `valid` | `risky` | `invalid` | `unknown` | `unverified` | `none`. */
  status: string;
  /** At least one address has no fresh verdict. */
  stale: boolean;
  /** Largest `checkedAt` among the fresh records; `0` when none. */
  checkedAt: number;
  addresses: AddressVerification[];
}

/** One page plus the aggregates the strip used to compute from a full list. */
export interface BusinessPage {
  rows: Business[];
  /** Rows matching the current filters. */
  total: number;
  /** Rows in the database, ignoring filters. */
  all: number;
  avgRating: number;
  rated: number;
  withPhone: number;
  types: { label: string; count: number }[];
  /** Attribution for the rows on this page only. */
  jobRefs: BusinessJobRef[];
  /** Email-verification state for the rows on this page only (G-04). */
  verifyRefs: BusinessVerificationRef[];
}

export interface BusinessStats {
  total: number;
  all: number;
  avgRating: number;
  rated: number;
  withPhone: number;
  types: { label: string; count: number }[];
}
