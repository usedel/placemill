//! Geographic grid for area collection (roadmap M2).
//!
//! Google Maps stops loading results after roughly 120 places per viewport, so
//! "all dentists in Los Angeles" is only reachable by visiting several map
//! centres. This module turns a centre + radius + cell size into that list of
//! centres. It is pure math on purpose: no I/O, no state, fully unit-testable.
//!
//! Cell size and zoom are coupled: a cell that is much smaller than the viewport
//! wastes requests (the same 120 places get re-fetched), much larger and results
//! fall into the gaps between cells. `zoom_for_cell` keeps them consistent, so
//! the UI only asks for a cell size.

use serde::{Deserialize, Serialize};

/// Upper bound for one job. Above this the run is minutes long and the account
/// is at risk, so the caller is told to raise the cell size instead.
pub const MAX_TILES: usize = 200;
pub const MIN_CELL_KM: f64 = 0.5;
pub const MAX_CELL_KM: f64 = 10.0;
pub const MIN_RADIUS_KM: f64 = 0.5;
pub const MAX_RADIUS_KM: f64 = 20.0;
pub const MIN_ZOOM: u8 = 12;
pub const MAX_ZOOM: u8 = 18;

/// Depth cap for quadtree subdivision (roadmap M4 / J-04a). With 2 km base
/// cells this allows 1 km and 0.5 km children; a third split would go below
/// `MIN_CELL_KM`, where `zoom_for_cell` clamps and the child covers the same
/// viewport as its parent.
pub const MAX_SPLIT_DEPTH: i64 = 3;

/// Kilometres per degree of latitude (mean value; good enough for grid spacing).
const KM_PER_DEG_LAT: f64 = 111.32;

/// Map width in kilometres covered by a ~1000 px viewport at zoom 0.
/// 40 075 km / 256 px * 1000 px ≈ 156 543 km.
pub(crate) const VIEWPORT_KM_AT_Z0: f64 = 156_543.0;

/// Mean earth radius, for `distance_km` only. The grid itself uses the flat
/// `KM_PER_DEG_LAT` approximation, which is accurate at cell scale; the radius
/// filter has to work over any distance, so it uses the real great circle.
const EARTH_RADIUS_KM: f64 = 6_371.0088;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub id: String,
    pub seq: u32,
    pub lat: f64,
    pub lng: f64,
    pub zoom: u8,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub tiles: Vec<Tile>,
    pub zoom: u8,
    pub cell_km: f64,
}

/// Zoom whose viewport covers at least `cell_km`, clamped to a usable range.
///
/// `floor`, not `round`: the viewport must never be *smaller* than the cell, or
/// neighbouring cells leave uncovered gaps. With `round` a 1.5 km cell landed on
/// zoom 17, whose viewport covers only 0.99 km — a third of every cell was
/// never shown. `floor` errs towards wider views (and harmless overlap).
///
/// The trade-off is real and measured: for a 10 km cell `floor` drops to zoom 13
/// and that wide a viewport measurably changes what Google returns for the same
/// keyword (36 vs ~60 places inside a 3 km circle in the split suite). Floor
/// still wins — `round` can under-cover a cell by up to ~40 %, while `floor`'s
/// worst case is ~17 % — but it is one more reason to prefer the standard cell
/// steps (0.5 / 1 / 2 / 4 / 8 km), which land within a few percent of 1:1.
///
/// The constant assumes a ~1000 px viewport; the real `maps` pane is often
/// ~830 CSS px, so coverage can be up to ~17 % narrower than this formula says.
pub fn zoom_for_cell(cell_km: f64) -> u8 {
    let cell = if cell_km.is_finite() {
        cell_km.clamp(MIN_CELL_KM, MAX_CELL_KM)
    } else {
        MIN_CELL_KM
    };
    let raw = (VIEWPORT_KM_AT_Z0 / cell).log2().floor();
    (raw as i64).clamp(MIN_ZOOM as i64, MAX_ZOOM as i64) as u8
}

/// Cell size after `depth` subdivisions of `base_cell_km`.
pub fn cell_at_depth(base_cell_km: f64, depth: i64) -> f64 {
    base_cell_km / 2f64.powi(depth.clamp(0, 8) as i32)
}

/// Whether a dense tile may be subdivided.
///
/// Two independent guards: the depth cap (prevents an endless quadtree on a
/// pathological query) and the minimum cell size (below 0.5 km the viewport is
/// already at the maximum zoom, so children would re-read their parent's area
/// and merely multiply requests).
pub fn can_split(depth: i64, base_cell_km: f64) -> bool {
    depth < MAX_SPLIT_DEPTH && cell_at_depth(base_cell_km, depth + 1) >= MIN_CELL_KM
}

/// Centres of the four quadrants of a cell, offset by a quarter cell so each
/// child sits in the middle of its quadrant. Longitude offset widens with
/// latitude for the same reason as the initial grid.
pub fn quadrant_centers(lat: f64, lng: f64, cell_km: f64) -> [(f64, f64); 4] {
    let lat_offset = (cell_km / 4.0) / KM_PER_DEG_LAT;
    let cos_lat = lat.to_radians().cos().abs().max(0.05);
    let lng_offset = (cell_km / 4.0) / (KM_PER_DEG_LAT * cos_lat);
    [
        (lat + lat_offset, lng - lng_offset),
        (lat + lat_offset, lng + lng_offset),
        (lat - lat_offset, lng - lng_offset),
        (lat - lat_offset, lng + lng_offset),
    ]
}

/// Great-circle distance between two points, in kilometres.
///
/// Used by the radius filter in `store_businesses`: the value has to be right
/// for any separation (a stray row can be a thousand kilometres out), which the
/// flat per-degree approximation used for grid spacing is not.
pub fn distance_km(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    if !lat1.is_finite() || !lng1.is_finite() || !lat2.is_finite() || !lng2.is_finite() {
        return f64::INFINITY;
    }
    let (phi1, phi2) = (lat1.to_radians(), lat2.to_radians());
    let d_phi = phi2 - phi1;
    let d_lambda = (lng2 - lng1).to_radians();
    let a = (d_phi / 2.0).sin().powi(2)
        + phi1.cos() * phi2.cos() * (d_lambda / 2.0).sin().powi(2);
    // `clamp` keeps `asin` inside its domain when rounding pushes `a` past 1.
    2.0 * EARTH_RADIUS_KM * a.sqrt().clamp(0.0, 1.0).asin()
}

/// Whether a point falls inside the circle a job was created with.
///
/// Non-finite coordinates are rejected: the ingress guard zeroes them, so they
/// would otherwise be a valid-looking row at 0,0.
pub fn within_radius(
    center_lat: f64,
    center_lng: f64,
    lat: f64,
    lng: f64,
    radius_km: f64,
) -> bool {
    distance_km(center_lat, center_lng, lat, lng) <= radius_km
}

/// Build the tile list. Tiles are ordered centre-out so that a cancelled or
/// interrupted run still covered the densest part of the area first.
pub fn generate(
    center_lat: f64,
    center_lng: f64,
    radius_km: f64,
    cell_km: f64,
) -> Result<Plan, String> {
    if !center_lat.is_finite() || !center_lng.is_finite() {
        return Err("invalid_center".to_string());
    }
    // Beyond ±85° the longitude step explodes; OpenStreetMap-style clamping is
    // the honest answer rather than a grid nobody asked for.
    if center_lat.abs() > 85.0 || center_lng.abs() > 180.0 {
        return Err("invalid_center".to_string());
    }
    if !radius_km.is_finite() || !(MIN_RADIUS_KM..=MAX_RADIUS_KM).contains(&radius_km) {
        return Err("radius_out_of_range".to_string());
    }
    if !cell_km.is_finite() || !(MIN_CELL_KM..=MAX_CELL_KM).contains(&cell_km) {
        return Err("cell_out_of_range".to_string());
    }

    // The cell is deliberately NOT shrunk to the radius.
    //
    // `zoom_for_cell` rounds to a whole zoom level, and the real `maps` pane is
    // ~830 CSS px wide (not the 1000 the constant assumes). At 830 px a zoom-16
    // viewport covers 1.98 km, i.e. almost exactly a 2 km cell, while a 1.5 km
    // cell lands on zoom 17 and its viewport covers only 0.99 km. Shrinking the
    // cell would therefore widen the gaps between cells to 34 % of the area
    // instead of closing them. The ring rule below is what keeps coverage
    // complete; `store_businesses` is what keeps the *data* inside the radius.
    let zoom = zoom_for_cell(cell_km);
    let lat_step = cell_km / KM_PER_DEG_LAT;
    // Longitude degrees are shorter away from the equator; without this the
    // cells overlap heavily at high latitude.
    let cos_lat = center_lat.to_radians().cos().abs().max(0.05);
    let lng_step = cell_km / (KM_PER_DEG_LAT * cos_lat);

    let steps = (radius_km / cell_km).ceil() as i32;
    // Keep cells whose centre is within the circle plus half a cell, otherwise
    // the ring that straddles the edge is silently dropped. Removing the half
    // cell leaves a band of the circle uncovered whenever a cell is not aligned
    // with the viewport (1.5 km radius, 1.5 km cell: the 0.99 km viewport leaves
    // the 0.75–1.5 km diagonal empty).
    let keep_within_km = radius_km + cell_km / 2.0;

    let mut cells: Vec<(i32, i32, f64)> = Vec::new();
    for dy in -steps..=steps {
        for dx in -steps..=steps {
            let dx_km = f64::from(dx) * cell_km;
            let dy_km = f64::from(dy) * cell_km;
            let distance = (dx_km * dx_km + dy_km * dy_km).sqrt();
            if distance > keep_within_km {
                continue;
            }
            cells.push((dx, dy, distance));
        }
    }

    // Centre-out: the first tile is the user's centre.
    cells.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

    if cells.len() > MAX_TILES {
        return Err("grid_too_large".to_string());
    }
    if cells.is_empty() {
        return Err("grid_empty".to_string());
    }

    let tiles = cells
        .iter()
        .enumerate()
        .map(|(index, (dx, dy, _))| Tile {
            id: format!("t{}", index),
            seq: index as u32,
            lat: center_lat + f64::from(*dy) * lat_step,
            lng: center_lng + f64::from(*dx) * lng_step,
            zoom,
        })
        .collect();

    Ok(Plan {
        tiles,
        zoom,
        cell_km,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_tile_is_the_centre() {
        let plan = generate(34.0522, -118.2437, 5.0, 2.0).expect("plan");
        let first = &plan.tiles[0];
        assert!((first.lat - 34.0522).abs() < 1e-9);
        assert!((first.lng - -118.2437).abs() < 1e-9);
        assert_eq!(first.id, "t0");
    }

    #[test]
    fn every_tile_centre_falls_inside_the_area() {
        let radius = 5.0;
        let cell = 2.0;
        let plan = generate(48.8566, 2.3522, radius, cell).expect("plan");
        for tile in &plan.tiles {
            // Half a cell of slack is what closes the ring that straddles the
            // rim; the write-side radius filter is what keeps *data* inside.
            let distance = distance_km(48.8566, 2.3522, tile.lat, tile.lng);
            assert!(
                distance <= radius + cell / 2.0 + 0.01,
                "tile {} is {} km out",
                tile.id,
                distance
            );
        }
    }

    #[test]
    fn centre_out_ordering() {
        let plan = generate(0.0, 0.0, 4.0, 2.0).expect("plan");
        let distances: Vec<f64> = plan
            .tiles
            .iter()
            .map(|tile| {
                let dx = tile.lng * KM_PER_DEG_LAT;
                let dy = tile.lat * KM_PER_DEG_LAT;
                (dx * dx + dy * dy).sqrt()
            })
            .collect();
        for pair in distances.windows(2) {
            assert!(pair[0] <= pair[1] + 1e-9, "{:?} is not sorted", pair);
        }
        assert_eq!(plan.tiles.len() as u32, plan.tiles.last().unwrap().seq + 1);
    }

    #[test]
    fn longitude_step_widens_at_high_latitude() {
        let equator = generate(0.0, 0.0, 4.0, 2.0).expect("plan");
        let north = generate(60.0, 0.0, 4.0, 2.0).expect("plan");
        let delta = |tiles: &[Tile]| {
            tiles
                .iter()
                .map(|tile| tile.lng)
                .fold(f64::MIN, f64::max)
                - tiles.iter().map(|tile| tile.lng).fold(f64::MAX, f64::min)
        };
        assert!(
            delta(&north.tiles) > delta(&equator.tiles) * 1.8,
            "60° should need roughly twice the longitude span"
        );
    }

    #[test]
    fn zoom_tracks_cell_size() {
        // Floor, not round: the viewport may be wider than the cell but never
        // narrower. 10 km used to land on 14, whose ~9.5 km viewport is fine,
        // but a 1.5 km cell landed on 17 with a 0.99 km viewport and left a
        // third of every cell unseen.
        assert_eq!(zoom_for_cell(10.0), 13);
        assert_eq!(zoom_for_cell(2.0), 16);
        assert_eq!(zoom_for_cell(1.5), 16);
        assert_eq!(zoom_for_cell(0.5), MAX_ZOOM);
        // An oversized cell is clamped to MAX_CELL_KM before the zoom is
        // derived, so it lands on the same zoom as 10 km — not on MIN_ZOOM.
        assert_eq!(zoom_for_cell(50.0), zoom_for_cell(MAX_CELL_KM));
    }

    #[test]
    fn the_viewport_never_falls_below_the_cell() {
        // Every cell the dialog offers must be fully inside its viewport, so
        // adjacent tiles cannot leave uncovered strips between them.
        for cell in [0.5, 1.0, 2.0, 4.0, 8.0, 10.0] {
            let zoom = zoom_for_cell(cell);
            let coverage = VIEWPORT_KM_AT_Z0 / 2f64.powi(i32::from(zoom));
            assert!(
                coverage + 1e-9 >= cell,
                "cell {} km got zoom {} ({} km viewport)",
                cell,
                zoom,
                coverage
            );
        }
    }

    #[test]
    fn a_cell_larger_than_the_area_yields_one_tile() {
        // 1 km radius, 5 km cell: the centre tile is the only one whose centre
        // is within radius + half a cell, so the grid is a single request.
        let plan = generate(10.0, 10.0, 1.0, 5.0).expect("plan");
        assert!((plan.cell_km - 5.0).abs() < 1e-9);
        assert_eq!(plan.zoom, zoom_for_cell(5.0));
        assert_eq!(plan.tiles.len(), 1);
    }

    #[test]
    fn a_small_radius_keeps_a_small_covering_ring() {
        // The reported job: 1.5 km radius, 2 km cell. Five tiles — the centre
        // plus the four orthogonal neighbours at 2 km — and every centre within
        // radius + half a cell. The 23 tiles that run actually executed were
        // the quadtree splitting on rows Google had loaded kilometres away, not
        // the initial grid; the split counter is what has to change, not this.
        let (center_lat, center_lng) = (22.352724, 114.1394);
        let plan = generate(center_lat, center_lng, 1.5, 2.0).expect("plan");
        assert_eq!(plan.tiles.len(), 5);
        for tile in &plan.tiles {
            let distance = distance_km(center_lat, center_lng, tile.lat, tile.lng);
            assert!(
                distance <= 1.5 + 1.0 + 1e-6,
                "tile {} centre is {} km out",
                tile.id,
                distance
            );
        }
    }

    #[test]
    fn distance_is_measured_on_the_sphere() {
        // One degree of latitude is ~111.2 km anywhere.
        assert!((distance_km(0.0, 0.0, 1.0, 0.0) - 111.19).abs() < 0.5);
        // Kowloon to Shanghai, the stray row from the reported run.
        let far = distance_km(22.352724, 114.1394, 31.2689599, 121.5865799);
        assert!((far - 1235.0).abs() < 15.0, "got {} km", far);
        // Same point.
        assert!(distance_km(22.35, 114.13, 22.35, 114.13) < 1e-9);
        // Degenerate input must not yield a "near" answer.
        assert!(!within_radius(22.35, 114.13, f64::NAN, 114.13, 5.0));
        assert!(!within_radius(22.35, 114.13, 0.0, 0.0, 5.0));
    }

    #[test]
    fn radius_filter_keeps_the_rim_and_drops_the_rest() {
        assert!(within_radius(22.352724, 114.1394, 22.357, 114.1394, 1.5));
        assert!(within_radius(22.352724, 114.1394, 22.3615, 114.1394, 1.5));
        // Sha Tin, ~8 km away.
        assert!(!within_radius(22.352724, 114.1394, 22.389027, 114.2090278, 1.5));
    }

    #[test]
    fn oversized_grids_are_rejected() {
        let error = generate(0.0, 0.0, 20.0, 0.5).unwrap_err();
        assert_eq!(error, "grid_too_large");
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        assert_eq!(generate(0.0, 0.0, 0.1, 2.0).unwrap_err(), "radius_out_of_range");
        assert_eq!(generate(0.0, 0.0, 5.0, 0.1).unwrap_err(), "cell_out_of_range");
        assert_eq!(generate(f64::NAN, 0.0, 5.0, 2.0).unwrap_err(), "invalid_center");
        assert_eq!(generate(89.0, 0.0, 5.0, 2.0).unwrap_err(), "invalid_center");
    }

    #[test]
    fn quadrants_are_offset_by_a_quarter_cell() {
        let (lat, lng, cell) = (48.8566, 2.3522, 2.0);
        let centers = quadrant_centers(lat, lng, cell);
        let cos_lat = lat.to_radians().cos();
        for (child_lat, child_lng) in centers {
            let dy = (child_lat - lat).abs() * KM_PER_DEG_LAT;
            let dx = (child_lng - lng).abs() * KM_PER_DEG_LAT * cos_lat;
            // Quarter cell on each axis -> quarter * sqrt(2) on the diagonal.
            let expected = (cell / 4.0) * 2f64.sqrt();
            assert!(
                (dx.hypot(dy) - expected).abs() < 0.01,
                "child at {child_lat},{child_lng} is not a quarter cell off"
            );
        }
        // Four distinct quadrants, otherwise two children would overlap.
        assert!(centers[0].0 > lat && centers[1].0 > lat);
        assert!(centers[2].0 < lat && centers[3].0 < lat);
        assert!(centers[0].1 < lng && centers[2].1 < lng);
    }

    #[test]
    fn split_stops_at_the_depth_or_cell_limit() {
        assert_eq!(cell_at_depth(2.0, 0), 2.0);
        assert_eq!(cell_at_depth(2.0, 1), 1.0);
        assert_eq!(cell_at_depth(2.0, 2), 0.5);

        assert!(can_split(0, 2.0));
        assert!(can_split(1, 2.0));
        assert!(!can_split(2, 2.0), "a 0.25 km child is below the minimum");
        assert!(!can_split(3, 10.0), "depth cap");
        assert!(!can_split(0, MIN_CELL_KM), "base cell already at the minimum");
    }

    #[test]
    fn typical_run_stays_under_ten_minutes() {
        // 5 km / 2 km cells: a realistic "one neighbourhood" run.
        let plan = generate(34.0522, -118.2437, 5.0, 2.0).expect("plan");
        assert!(
            (15..=40).contains(&plan.tiles.len()),
            "unexpected tile count {}",
            plan.tiles.len()
        );
    }
}
