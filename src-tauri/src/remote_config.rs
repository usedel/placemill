//! Remote field-map config (roadmap M5 / G-05).
//!
//! Google's positional payload indices live in one small JSON document hosted
//! on GitHub Pages. When Google reshuffles its response layout, a corrected
//! map goes live without shipping a new binary. The fetch is deliberately
//! dumb — one GET, a three-second timeout, ETag revalidation — and everything
//! it downloads is *data*: numeric indices validated against a fixed shape.
//! The D4 boundary stands: the app never downloads executable code.
//!
//! Failure modes, in order of preference:
//! 1. Network down / HTTP error → the on-disk cache from the last successful
//!    fetch is used (validated again before use).
//! 2. No cache → `None`, the app runs on the built-in map baked into
//!    `intercept.js`.
//! 3. A config that fails validation is never applied; the cache (if any)
//!    survives, so a botched publish does not take an already-working
//!    install down with it.

use crate::logging::{log_info, log_warn};
use minisign_verify::{PublicKey, Signature};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};

/// Published via GitHub Pages; the URL is a constant so there is exactly one
/// place to rotate when hosting moves.
pub const CONFIG_URL: &str =
    "https://usedel.github.io/placemill-config/stable/parser-config.json";

const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
/// Hard cap on one config body (R-32). The published file is a few hundred
/// bytes; anything larger is a broken deploy or a hostile mirror, and reading it
/// into memory is already the damage.
const MAX_CONFIG_BYTES: u64 = 256 * 1024;
/// Hard cap on the `.sig` sidecar (R-32b). A valid signature document is under
/// 400 bytes, so this only bounds a hostile mirror.
const MAX_SIGNATURE_BYTES: u64 = 4 * 1024;

/// Public half of the config-signing key, as the two-line minisign public-key
/// document (the same key the updater uses; `tauri.conf.json` stores the base64
/// of exactly this text). A compile-time constant on purpose: a config that
/// could nominate its own trust root would make the signature pointless, so
/// rotating the key means shipping a new build.
const CONFIG_PUBKEY: &str = "untrusted comment: minisign public key: 432281063F48F695\nRWSV9kg/BoEiQ89rpGdIvcN0/DVObMYrHlIfhN0/BgyMQ3yyVaeDJLNq\n";
/// Any positional index beyond this is nonsense rather than a layout change.
const MAX_INDEX: i64 = 2048;
const SCHEMA: i64 = 1;

/// Positional indices into Google's search-response payload. Serialized with
/// camelCase keys because this exact shape is handed to the injected script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMap {
    pub results_index: i64,
    pub name: i64,
    /// 1–2 fallbacks, tried in order (address historically moved 18 → 39).
    pub address: Vec<i64>,
    pub phone: i64,
    pub website: i64,
    pub types: i64,
    /// Sub-indices 2/3 (lat/lng inside the coordinate tuple) are fixed and not
    /// remotely configurable; only the container index moves in practice.
    pub coords: i64,
    /// 1–2 fallbacks, tried in order.
    pub place_id: Vec<i64>,
    /// Exactly 2: `[container, sub-index]`.
    pub rating: Vec<i64>,
    /// Exactly 2: `[container, sub-index]`.
    pub reviews: Vec<i64>,

    // ===== Fields added from M8 on (J-08a) =====
    //
    // Mechanism: every field added from here on is `Option<i64>` with
    // `#[serde(default)]`. A config published before the field existed still
    // parses — the key is simply absent, which means "not configured", and the
    // script falls back to its built-in value. Publishing a new index can
    // therefore never invalidate the config that is already in the field.
    //
    // The nine keys above stay required on purpose: their absence means the
    // layout really changed, and the app must fall back to the built-in map
    // and say so, rather than keep working with half a map.
    //
    // The value is the *container* index. Any deeper path inside it is a
    // constant of the format and lives in the script (like `coords` -> 2/3).

    /// Price level, e.g. "$$". Read as `detail[priceRange][2]`.
    ///
    /// The index comes from the reverse-engineered table of the open-source
    /// `gosom/google-maps-scraper`. The index probe (J-08b) found the slot
    /// empty in every sampled row of a real search payload — which cannot
    /// tell "the search payload does not carry the price level" apart from
    /// "these businesses have none" — so the mapping stays and the question
    /// is left open for the detail page (Tier-2). A remote config can move
    /// it without a release.
    #[serde(default)]
    pub price_range: Option<i64>,
    /// Time-zone id, e.g. "America/Los_Angeles". Read as `detail[timezone]`.
    ///
    /// Confirmed by the index probe (J-08b): filled in every sampled row of
    /// a real search payload.
    #[serde(default)]
    pub timezone: Option<i64>,
    /// Container of the structured address. Read as `detail[value][1][0..6]`
    /// — borough, street, city, postal code, state, country.
    ///
    /// Confirmed by the index probe (J-08b): all six parts were filled in
    /// every sampled row of a real search payload.
    #[serde(default)]
    pub complete_address: Option<i64>,
    /// Google's internal place id, e.g. "0x80c2…:0x49fd…".
    #[serde(default)]
    pub data_id: Option<i64>,
    /// Container of the reviews link. Read as `detail[value][3][0]`.
    #[serde(default)]
    pub reviews_link: Option<i64>,
    /// Container of the thumbnail. Read as `detail[value][0][1][6][0]`.
    #[serde(default)]
    pub thumbnail: Option<i64>,
    /// Container of the "about" block. Read as `detail[value][1]`.
    #[serde(default)]
    pub about: Option<i64>,
    /// Container of the owner entry. Read as `detail[value][1]`.
    #[serde(default)]
    pub owner: Option<i64>,
    /// Container of the opening hours. Read as `detail[value][0][i]`, where
    /// entry `[0]` is the weekday name and entry `[3]` holds the periods.
    #[serde(default)]
    pub open_hours: Option<i64>,
}

impl FieldMap {
    fn validate(&self) -> Result<(), String> {
        let single = |value: i64, what: &str| -> Result<(), String> {
            if (0..=MAX_INDEX).contains(&value) {
                Ok(())
            } else {
                Err(format!("{} out of range: {}", what, value))
            }
        };
        single(self.results_index, "resultsIndex")?;
        single(self.name, "name")?;
        single(self.phone, "phone")?;
        single(self.website, "website")?;
        single(self.types, "types")?;
        single(self.coords, "coords")?;
        for (what, list, min, max) in [
            ("address", &self.address, 1usize, 2usize),
            ("placeId", &self.place_id, 1usize, 2usize),
            ("rating", &self.rating, 2usize, 2usize),
            ("reviews", &self.reviews, 2usize, 2usize),
        ] {
            if list.len() < min || list.len() > max {
                return Err(format!(
                    "{} needs {}..={} entries, got {}",
                    what,
                    min,
                    max,
                    list.len()
                ));
            }
            for (position, value) in list.iter().enumerate() {
                single(*value, &format!("{}[{}]", what, position))?;
            }
        }
        // Optional fields (M8 / J-08a): `None` means "not configured" and is
        // always valid — that is the whole point of making them optional, so
        // an older config keeps working. A configured value gets the same
        // range check as the required ones.
        for (what, value) in [
            ("priceRange", self.price_range),
            ("timezone", self.timezone),
            ("completeAddress", self.complete_address),
            ("dataId", self.data_id),
            ("reviewsLink", self.reviews_link),
            ("thumbnail", self.thumbnail),
            ("about", self.about),
            ("owner", self.owner),
            ("openHours", self.open_hours),
        ] {
            if let Some(index) = value {
                single(index, what)?;
            }
        }
        Ok(())
    }
}

/// A validated remote document, ready to be pushed into the maps webview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFieldMap {
    pub map: FieldMap,
    pub version: String,
    pub channel: String,
    /// Optional miner heuristics (M7); `Default` when the document omits them.
    pub email_rules: EmailRules,
}

/// Hot-updatable heuristics for the site miner (M7). Pure data — string lists
/// only, consistent with regression baseline #9. The built-in defaults below
/// are what an offline install or an older config falls back to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EmailRules {
    /// Substrings that disqualify an address (builder fingerprints, role
    /// mailboxes, asset file names). Matched against the lowercased address.
    pub blocklist: Vec<String>,
    /// URL/anchor-text keywords that mark a same-domain link as a contact page.
    pub contact_keywords: Vec<String>,
}

impl Default for EmailRules {
    fn default() -> Self {
        EmailRules {
            blocklist: [
                "noreply", "no-reply", "donotreply", "no_reply", "sentto", "sentry",
                "wixpress", "example.com", "example.org", "domain.com", "yourdomain",
                "your-domain", "email.com", "test.com", "mysite.com", "godaddy",
                "cloudflare", "squarespace", "postmaster", "webmaster@wordpress",
                "abuse@", "admin@exchange", "u003e", "@sentry", "wix.com",
            ]
            .iter()
            .map(|entry| entry.to_string())
            .collect(),
            contact_keywords: [
                "contact", "about", "team", "support", "impressum", "kontakt",
                "enquiry", "inquiry", "reach-us", "reachus", "connect", "hire",
                "sales", "legal", "get-in-touch", "getintouch", "mail",
            ]
            .iter()
            .map(|entry| entry.to_string())
            .collect(),
        }
    }
}

impl EmailRules {
    fn validate(&self) -> Result<(), String> {
        for (what, list, cap) in [
            ("emailRules.blocklist", &self.blocklist, 200usize),
            ("emailRules.contactKeywords", &self.contact_keywords, 64usize),
        ] {
            if list.len() > cap {
                return Err(format!("{} has {} entries (max {})", what, list.len(), cap));
            }
            for entry in list {
                if entry.is_empty() || entry.len() > 64 {
                    return Err(format!("{} entry too long or empty", what));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct RemoteConfig {
    schema: i64,
    version: String,
    #[serde(default)]
    channel: String,
    #[serde(default, rename = "minAppVersion")]
    min_app_version: String,
    #[serde(rename = "fieldMap")]
    field_map: FieldMap,
    #[serde(default, rename = "emailRules")]
    email_rules: EmailRules,
}

/// Parse and validate one config document. Every rule here also exists in
/// `intercept.js` (`validFieldMap`): the script cannot trust its localStorage
/// mirror any more than Rust can trust the network.
fn parse_config(body: &str, app_version: &str) -> Result<RemoteFieldMap, String> {
    let config: RemoteConfig =
        serde_json::from_str(body).map_err(|error| format!("invalid JSON: {}", error))?;
    if config.schema != SCHEMA {
        return Err(format!(
            "unsupported schema {} (want {})",
            config.schema, SCHEMA
        ));
    }
    let version = config.version.trim().to_string();
    if version.is_empty() || version.len() > 64 {
        return Err("version missing or longer than 64 chars".to_string());
    }
    let channel = if config.channel.is_empty() {
        "stable".to_string()
    } else {
        config.channel.clone()
    };
    if channel != "stable" && channel != "beta" {
        return Err(format!("unknown channel: {}", channel));
    }
    if !satisfies_min_version(app_version, &config.min_app_version) {
        return Err(format!(
            "config needs app >= {}, running {}",
            config.min_app_version, app_version
        ));
    }
    config.field_map.validate()?;
    config.email_rules.validate()?;
    Ok(RemoteFieldMap {
        map: config.field_map,
        version,
        channel,
        email_rules: config.email_rules,
    })
}

/// Numeric semver-ish comparison. Missing components count as zero; an
/// unparseable minimum is a config error and rejects the document.
fn satisfies_min_version(app_version: &str, min_version: &str) -> bool {
    // R-19: `minAppVersion` carries a serde default of "", and an empty value
    // must mean "no constraint". The old code parsed "" and failed, which
    // rejected every config that simply omitted the field — contradicting the
    // default's own semantics. A non-empty but unparseable minimum stays a
    // config error.
    let min_version = min_version.trim();
    if min_version.is_empty() {
        return true;
    }
    let parse =
        |text: &str| -> Result<Vec<u64>, String> {
            text.trim()
                .split('.')
                .map(|part| part.parse::<u64>().map_err(|_| format!("bad version: {}", text)))
                .collect()
        };
    let (app, min) = match (parse(app_version), parse(min_version)) {
        (Ok(app), Ok(min)) => (app, min),
        _ => return false,
    };
    for position in 0..app.len().max(min.len()) {
        let current = app.get(position).copied().unwrap_or(0);
        let required = min.get(position).copied().unwrap_or(0);
        if current != required {
            return current > required;
        }
    }
    true
}

fn cache_paths(data_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let dir = data_dir.join("remote");
    (
        dir.join("field-map.json"),
        dir.join("field-map.sig"),
        dir.join("field-map.etag"),
    )
}

fn read_cache(data_dir: &Path, app_version: &str) -> Option<RemoteFieldMap> {
    let (cache_file, signature_file, _) = cache_paths(data_dir);
    let body = std::fs::read_to_string(cache_file).ok()?;
    // R-32b: the cache is verified like any other download. A cache written by a
    // pre-signing build (no sidecar) or edited on disk is not trusted; dropping
    // it costs one fetch, trusting it would defeat the signature entirely.
    let Some(signature) = std::fs::read_to_string(&signature_file).ok() else {
        log_warn!("cached field map has no signature sidecar; ignoring it");
        return None;
    };
    if let Err(error) = verify_config(&body, &signature) {
        log_warn!("cached field map signature rejected ({}); ignoring it", error);
        return None;
    }
    match parse_config(&body, app_version) {
        Ok(map) => Some(map),
        Err(error) => {
            log_warn!("cached field map rejected: {}", error);
            None
        }
    }
}

fn read_etag(data_dir: &Path) -> Option<String> {
    let (_, _, etag_file) = cache_paths(data_dir);
    let etag = std::fs::read_to_string(etag_file).ok()?;
    let etag = etag.trim().to_string();
    if etag.is_empty() {
        None
    } else {
        Some(etag)
    }
}

fn write_cache(data_dir: &Path, body: &str, signature: &str, etag: Option<&str>) {
    let (cache_file, signature_file, etag_file) = cache_paths(data_dir);
    if let Some(parent) = cache_file.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log_warn!("field-map cache dir failed: {}", error);
            return;
        }
    }
    if let Err(error) = std::fs::write(&cache_file, body) {
        log_warn!("field-map cache write failed: {}", error);
        return;
    }
    // The signature lands next to the body it covers. If it cannot be written,
    // drop the body too: a cache without a sidecar would only be rejected on the
    // next read anyway, and leaving it behind looks like a working cache.
    if let Err(error) = std::fs::write(&signature_file, signature) {
        log_warn!("field-map signature cache write failed: {}", error);
        let _ = std::fs::remove_file(&cache_file);
        return;
    }
    match etag {
        Some(tag) => {
            let _ = std::fs::write(&etag_file, tag);
        }
        None => {
            let _ = std::fs::remove_file(&etag_file);
        }
    }
}

/// Standard-alphabet base64 decoder (padding optional, whitespace ignored).
///
/// `minisign_verify` works on decoded documents, while both the configured
/// public key and the `.sig` sidecar produced by `tauri signer sign` are base64
/// wrapped (the updater unwraps them the same way). A crate for two ~100-byte
/// strings is not worth a dependency; this is small enough to test directly.
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            // Padding only ever trails the last group.
            b'=' => break,
            b'\r' | b'\n' | b' ' | b'\t' => continue,
            other => return Err(format!("invalid base64 byte 0x{:02x}", other)),
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn decode_base64_text(input: &str) -> Result<String, String> {
    let bytes = decode_base64(input)?;
    String::from_utf8(bytes).map_err(|error| format!("base64 payload is not UTF-8: {}", error))
}

/// Verify `body` against a `.sig` sidecar (base64 of the four-line minisign
/// document, exactly what `tauri signer sign` writes).
///
/// `public_key_text` is the decoded public-key document, not the base64 form.
fn verify_signature(
    public_key_text: &str,
    body: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let key =
        PublicKey::decode(public_key_text).map_err(|error| format!("public key: {}", error))?;
    let signature_text = decode_base64_text(signature_b64)?;
    let signature =
        Signature::decode(&signature_text).map_err(|error| format!("signature: {}", error))?;
    // `allow_legacy = true` mirrors the updater: current minisign signs the
    // pre-hashed body, older keys signed it directly and both must keep working.
    key.verify(body.as_bytes(), &signature, true)
        .map_err(|error| error.to_string())
}

fn verify_config(body: &str, signature_b64: &str) -> Result<(), String> {
    verify_signature(CONFIG_PUBKEY, body, signature_b64)
}

/// Download the `.sig` sidecar next to the config.
///
/// No ETag: the file is a few hundred bytes, and reusing a signature for a body
/// that changed is exactly what the check must catch.
fn fetch_signature() -> Result<String, String> {
    let url = format!("{}.sig", CONFIG_URL);
    match fetch_body(&url, None)? {
        Some((body, _)) => {
            if body.len() as u64 > MAX_SIGNATURE_BYTES {
                return Err(format!("signature exceeds {} bytes", MAX_SIGNATURE_BYTES));
            }
            Ok(body)
        }
        None => Err("signature request answered 304 without a body".to_string()),
    }
}

/// `Ok(Some(..))` = fresh body, `Ok(None)` = 304 (cache still current).
fn fetch_body(url: &str, etag: Option<&str>) -> Result<Option<(String, Option<String>)>, String> {
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
    let mut request = agent.get(url);
    if let Some(tag) = etag {
        request = request.set("If-None-Match", tag);
    }
    match request.call() {
        Ok(response) => {
            let status = response.status();
            // ureq (2.12) only maps statuses >= 400 to `Error::Status`. A 304 —
            // which is what GitHub Pages answers while our ETag is current —
            // arrives here as an Ok response with an EMPTY body (the redirect
            // loop breaks on a 3xx without a `Location` header). Handle the
            // status explicitly so the 304 path works on any ureq version.
            if status == 304 {
                return Ok(None);
            }
            let etag = response.header("etag").map(|value| value.to_string());
            // R-32: read one byte past the cap so "exactly at the limit" is not
            // confused with "over it". `into_string()` had no bound of its own.
            let mut body = String::new();
            response
                .into_reader()
                .take(MAX_CONFIG_BYTES + 1)
                .read_to_string(&mut body)
                .map_err(|error| format!("read body: {}", error))?;
            if body.len() as u64 > MAX_CONFIG_BYTES {
                return Err(format!(
                    "config body exceeds {} bytes",
                    MAX_CONFIG_BYTES
                ));
            }
            if !(200..300).contains(&status) {
                return Err(format!("HTTP {}", status));
            }
            if body.trim().is_empty() {
                return Err(format!("HTTP {} with an empty body", status));
            }
            Ok(Some((body, etag)))
        }
        // Kept for ureq versions that do report 3xx as `Error::Status`.
        Err(ureq::Error::Status(304, _)) => Ok(None),
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {}", code)),
        Err(error) => Err(format!("transport: {}", error)),
    }
}

/// What the app falls back to when a fetch or a check fails.
fn describe_fallback(cached: &Option<RemoteFieldMap>) -> String {
    cached
        .as_ref()
        .map(|map| format!("cached {}", map.version))
        .unwrap_or_else(|| "built-in".to_string())
}

/// One fetch round: network first, the on-disk cache as every fallback.
/// `None` means the app runs on the built-in map.
///
/// R-32b: the body is only parsed after its `.sig` sidecar verifies against the
/// key baked into this binary. An unsigned or tampered body is discarded and the
/// previously verified cache (or the built-in map) keeps working.
pub fn load_remote_field_map(data_dir: &Path, app_version: &str) -> Option<RemoteFieldMap> {
    let cached = read_cache(data_dir, app_version);
    let etag = read_etag(data_dir);

    match fetch_body(CONFIG_URL, etag.as_deref()) {
        Ok(Some((body, new_etag))) => {
            let signature = match fetch_signature() {
                Ok(signature) => signature,
                Err(error) => {
                    log_warn!(
                        "remote field map has no usable signature ({}); keeping {}",
                        error,
                        describe_fallback(&cached)
                    );
                    return cached;
                }
            };
            if let Err(error) = verify_config(&body, &signature) {
                log_warn!(
                    "remote field map signature rejected ({}); keeping {}",
                    error,
                    describe_fallback(&cached)
                );
                return cached;
            }
            match parse_config(&body, app_version) {
                Ok(map) => {
                    write_cache(data_dir, &body, &signature, new_etag.as_deref());
                    log_info!(
                        "remote field map fetched: {} ({})",
                        map.version, map.channel
                    );
                    Some(map)
                }
                Err(error) => {
                    log_warn!(
                        "remote field map rejected ({}); keeping {}",
                        error,
                        describe_fallback(&cached)
                    );
                    cached
                }
            }
        }
        Ok(None) => cached,
        Err(error) => {
            log_warn!(
                "remote field map unavailable ({}); offline fallback",
                error
            );
            cached
        }
    }
}

/// Drop the on-disk cache after a parse degradation, so a bad publish cannot
/// come back on the next startup via the offline path.
pub fn clear_cache(data_dir: &Path) {
    let (cache_file, signature_file, etag_file) = cache_paths(data_dir);
    let _ = std::fs::remove_file(cache_file);
    let _ = std::fs::remove_file(signature_file);
    let _ = std::fs::remove_file(etag_file);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "schema": 1,
      "version": "2026.10.1",
      "channel": "stable",
      "minAppVersion": "0.1.0",
      "fieldMap": {
        "resultsIndex": 64, "name": 11, "address": [39, 18], "phone": 178,
        "website": 7, "types": 76, "coords": 9, "placeId": [78, 10],
        "rating": [4, 7], "reviews": [4, 8]
      }
    }"#;

    #[test]
    fn the_published_document_parses() {
        let config = parse_config(SAMPLE, "0.1.0").expect("config");
        assert_eq!(config.version, "2026.10.1");
        assert_eq!(config.channel, "stable");
        assert_eq!(config.map.name, 11);
        assert_eq!(config.map.address, vec![39, 18]);
        assert_eq!(config.map.rating, vec![4, 7]);
    }

    #[test]
    fn wrong_schema_or_channel_is_rejected() {
        let bad_schema = SAMPLE.replace("\"schema\": 1", "\"schema\": 2");
        assert!(parse_config(&bad_schema, "0.1.0").is_err());

        let bad_channel = SAMPLE.replace("\"channel\": \"stable\"", "\"channel\": \"canary\"");
        assert!(parse_config(&bad_channel, "0.1.0").is_err());
    }

    #[test]
    fn out_of_range_indices_are_rejected() {
        let negative = SAMPLE.replace("\"name\": 11", "\"name\": -3");
        assert!(parse_config(&negative, "0.1.0").is_err());

        let huge = SAMPLE.replace("\"name\": 11", "\"name\": 99999");
        assert!(parse_config(&huge, "0.1.0").is_err());

        let bad_shape = SAMPLE.replace("\"address\": [39, 18]", "\"address\": [39, 18, 7]");
        assert!(parse_config(&bad_shape, "0.1.0").is_err());

        let short_rating = SAMPLE.replace("\"rating\": [4, 7]", "\"rating\": [4]");
        assert!(parse_config(&short_rating, "0.1.0").is_err());
    }

    // ----- M8 / J-08a: optional fields -----

    #[test]
    fn a_config_without_the_new_fields_still_parses() {
        // The whole point of J-08a: a config published before a field existed
        // must keep working. `SAMPLE` predates `priceRange`/`timezone`.
        let config = parse_config(SAMPLE, "0.1.0").expect("config");
        assert_eq!(config.map.price_range, None);
        assert_eq!(config.map.timezone, None);
        assert_eq!(config.map.name, 11);
    }

    #[test]
    fn new_optional_fields_are_read_when_present() {
        let with_new = SAMPLE.replace(
            "\"reviews\": [4, 8]",
            "\"reviews\": [4, 8], \"priceRange\": 4, \"timezone\": 30",
        );
        let config = parse_config(&with_new, "0.1.0").expect("config");
        assert_eq!(config.map.price_range, Some(4));
        assert_eq!(config.map.timezone, Some(30));
    }

    /// M8 / J-08c: the new container indices are optional on both sides, so
    /// a config that predates them keeps working.
    #[test]
    fn the_j08c_optional_fields_are_read_when_present() {
        let with_new = SAMPLE.replace(
            "\"reviews\": [4, 8]",
            "\"reviews\": [4, 8], \"completeAddress\": 183, \"dataId\": 10, \
             \"reviewsLink\": 4, \"thumbnail\": 72, \"about\": 100, \"owner\": 57, \
             \"openHours\": 203",
        );
        let config = parse_config(&with_new, "0.1.0").expect("config");
        assert_eq!(config.map.complete_address, Some(183));
        assert_eq!(config.map.data_id, Some(10));
        assert_eq!(config.map.reviews_link, Some(4));
        assert_eq!(config.map.thumbnail, Some(72));
        assert_eq!(config.map.about, Some(100));
        assert_eq!(config.map.owner, Some(57));
        assert_eq!(config.map.open_hours, Some(203));

        // A config without them is still valid — that is the whole point of
        // making them optional.
        let old = parse_config(SAMPLE, "0.1.0").expect("config");
        assert_eq!(old.map.complete_address, None);
        assert_eq!(old.map.open_hours, None);

        // And a broken one is rejected rather than silently ignored.
        let broken = SAMPLE.replace(
            "\"reviews\": [4, 8]",
            "\"reviews\": [4, 8], \"thumbnail\": 99999",
        );
        assert!(parse_config(&broken, "0.1.0").is_err());
    }

    #[test]
    fn a_null_optional_field_means_not_configured() {
        // `null` is what the map serializes to when the field is unset, so the
        // wire format has to accept it back.
        let with_null = SAMPLE.replace(
            "\"reviews\": [4, 8]",
            "\"reviews\": [4, 8], \"priceRange\": null",
        );
        let config = parse_config(&with_null, "0.1.0").expect("config");
        assert_eq!(config.map.price_range, None);
    }

    #[test]
    fn an_out_of_range_optional_field_is_rejected() {
        let huge = SAMPLE.replace(
            "\"reviews\": [4, 8]",
            "\"reviews\": [4, 8], \"priceRange\": 99999",
        );
        assert!(parse_config(&huge, "0.1.0").is_err());

        let negative = SAMPLE.replace(
            "\"reviews\": [4, 8]",
            "\"reviews\": [4, 8], \"timezone\": -1",
        );
        assert!(parse_config(&negative, "0.1.0").is_err());
    }

    #[test]
    fn the_serialized_map_carries_the_new_keys_as_null() {
        // The map is handed to the injected script verbatim, so the wire shape
        // is part of the contract: an unset optional field travels as `null`,
        // which the script reads as "not configured".
        let config = parse_config(SAMPLE, "0.1.0").expect("config");
        let value = serde_json::to_value(&config.map).expect("map");
        assert!(value.get("priceRange").is_some());
        assert!(value["priceRange"].is_null());
        assert!(value["timezone"].is_null());
        assert_eq!(value["name"], 11);
    }

    #[test]
    fn min_app_version_gates_the_config() {
        assert!(parse_config(SAMPLE, "0.1.0").is_ok());
        assert!(parse_config(SAMPLE, "0.2.0").is_ok());
        let demanding = SAMPLE.replace("\"minAppVersion\": \"0.1.0\"", "\"minAppVersion\": \"0.2\"");
        assert!(parse_config(&demanding, "0.1.0").is_err());

        // An unparseable minimum is a config error, not a reason to apply.
        let garbage = SAMPLE.replace("\"minAppVersion\": \"0.1.0\"", "\"minAppVersion\": \"soon\"");
        assert!(parse_config(&garbage, "0.1.0").is_err());

        // R-19: an absent (or empty) minAppVersion means "no constraint" — the
        // serde default made "" the normal shape for configs that omit the
        // field, and rejecting them defeated that default.
        let no_field = SAMPLE.replace("\"minAppVersion\": \"0.1.0\",\n", "");
        assert!(parse_config(&no_field, "0.1.0").is_ok());
        let empty_value =
            SAMPLE.replace("\"minAppVersion\": \"0.1.0\"", "\"minAppVersion\": \"\"");
        assert!(parse_config(&empty_value, "0.1.0").is_ok());
        assert!(satisfies_min_version("0.1.0", ""));
        assert!(satisfies_min_version("0.1.0", "  "));
    }

    #[test]
    fn email_rules_default_when_absent_and_hot_update_when_present() {
        // The published document has no emailRules yet: the miner uses the
        // built-in heuristics.
        let config = parse_config(SAMPLE, "0.1.0").expect("config");
        assert_eq!(config.email_rules, EmailRules::default());

        let customized = SAMPLE.replace(
            "\"fieldMap\": {",
            "\"emailRules\": { \"blocklist\": [\"noreply\", \"spammy\"], \"contactKeywords\": [\"kontakt\"] }, \"fieldMap\": {",
        );
        let config = parse_config(&customized, "0.1.0").expect("config");
        assert_eq!(config.email_rules.blocklist, vec!["noreply", "spammy"]);
        assert_eq!(config.email_rules.contact_keywords, vec!["kontakt"]);

        // A blocklist entry that is too long is a config error, not a crash.
        let long = "x".repeat(80);
        let bad = SAMPLE.replace(
            "\"fieldMap\": {",
            &format!("\"emailRules\": {{ \"blocklist\": [\"{}\"] }}, \"fieldMap\": {{", long),
        );
        assert!(parse_config(&bad, "0.1.0").is_err());
    }

    #[test]
    fn version_comparison_is_componentwise() {
        assert!(satisfies_min_version("0.1.0", "0.1.0"));
        assert!(satisfies_min_version("1.0.0", "0.9"));
        assert!(satisfies_min_version("0.1.2", "0.1"));
        // Missing components count as zero, so 0.1 == 0.1.0.
        assert!(satisfies_min_version("0.1", "0.1.0"));
        assert!(!satisfies_min_version("0.1.0", "0.2"));
    }

    #[test]
    fn cache_round_trip_survives_a_restart() {
        let data_dir =
            std::env::temp_dir().join(format!("placemill-m5-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);

        // Nothing cached and no network in tests: the cache read is empty.
        assert!(read_cache(&data_dir, "0.1.0").is_none());

        // R-32b: a cache written by a pre-signing build has no sidecar and is
        // ignored. The bundled sample cannot be signed here (no private key), so
        // the positive path is covered by `a_matching_signature_verifies`.
        let (cache_file, signature_file, _) = cache_paths(&data_dir);
        std::fs::create_dir_all(cache_file.parent().expect("cache dir")).expect("create");
        std::fs::write(&cache_file, SAMPLE).expect("write body");
        assert!(read_cache(&data_dir, "0.1.0").is_none());

        // A sidecar that does not cover this body is refused too.
        std::fs::write(&signature_file, base64_encode(SAMPLE_SIGNATURE.as_bytes()))
            .expect("write sig");
        assert!(read_cache(&data_dir, "0.1.0").is_none());

        write_cache(
            &data_dir,
            SAMPLE,
            &base64_encode(SAMPLE_SIGNATURE.as_bytes()),
            Some("\"etag-1\""),
        );
        assert_eq!(read_etag(&data_dir).as_deref(), Some("\"etag-1\""));

        clear_cache(&data_dir);
        assert!(read_cache(&data_dir, "0.1.0").is_none());
        assert!(read_etag(&data_dir).is_none());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // ----- R-32b: signature checks -----

    /// Public half of the key `minisign-verify` uses in its own documentation.
    /// The signature below covers exactly the bytes `test`.
    const SAMPLE_PUBKEY: &str = "untrusted comment: test key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SAMPLE_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    fn base64_encode(input: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
        for chunk in input.chunks(3) {
            let first = u32::from(chunk[0]);
            let second = u32::from(*chunk.get(1).unwrap_or(&0));
            let third = u32::from(*chunk.get(2).unwrap_or(&0));
            let group = (first << 16) | (second << 8) | third;
            out.push(TABLE[((group >> 18) & 63) as usize] as char);
            out.push(TABLE[((group >> 12) & 63) as usize] as char);
            out.push(if chunk.len() > 1 {
                TABLE[((group >> 6) & 63) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                TABLE[(group & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn base64_roundtrips_through_the_decoder() {
        let samples: [&[u8]; 7] = [b"", b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"];
        for sample in samples {
            assert_eq!(decode_base64(&base64_encode(sample)).expect("decode"), sample);
        }
        // Whitespace (a wrapped ``.sig`` file) is ignored; anything else is an error.
        assert_eq!(decode_base64("aGVs\nbG8=").expect("decode"), b"hello");
        assert!(decode_base64("not base64!").is_err());
    }

    #[test]
    fn a_matching_signature_verifies() {
        let signature = base64_encode(SAMPLE_SIGNATURE.as_bytes());
        assert!(verify_signature(SAMPLE_PUBKEY, "test", &signature).is_ok());
    }

    #[test]
    fn a_modified_body_is_rejected() {
        let signature = base64_encode(SAMPLE_SIGNATURE.as_bytes());
        assert!(verify_signature(SAMPLE_PUBKEY, "test ", &signature).is_err());
        // Wrong key, right signature.
        assert!(verify_signature(CONFIG_PUBKEY, "test", &signature).is_err());
    }

    #[test]
    fn an_unwrapped_signature_document_is_rejected() {
        // A `.minisig` file copied verbatim: the colons and spaces are not base64.
        assert!(verify_signature(SAMPLE_PUBKEY, "test", SAMPLE_SIGNATURE).is_err());
    }

    #[test]
    fn the_configured_key_parses() {
        // Guards a typo in the constant: a malformed key would silently disable
        // every remote config (the fetch would be rejected as unverifiable).
        assert!(PublicKey::decode(CONFIG_PUBKEY).is_ok());
    }
}
