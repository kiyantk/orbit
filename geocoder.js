const Database = require("better-sqlite3");

const SCALE = 100_000;
const GRID_SIZE = 0.10;

const GRID_COLUMNS = Math.round(360 / GRID_SIZE);
const GRID_ROWS = Math.round(180 / GRID_SIZE);


// ============================================================
// GRID
// ============================================================

function longitudeToGridX(lon) {
    let x = Math.floor((lon + 180) / GRID_SIZE);

    if (x < 0) x = 0;
    if (x >= GRID_COLUMNS) x = GRID_COLUMNS - 1;

    return x;
}

function latitudeToGridY(lat) {
    let y = Math.floor((lat + 90) / GRID_SIZE);

    if (y < 0) y = 0;
    if (y >= GRID_ROWS) y = GRID_ROWS - 1;

    return y;
}

function gridCellId(lon, lat) {
    const x = longitudeToGridX(lon);
    const y = latitudeToGridY(lat);

    return y * GRID_COLUMNS + x;
}


// ============================================================
// VARINT DECODER
// ============================================================

function readUnsignedVarint(buffer, state) {
    let result = 0;
    let multiplier = 1;

    while (true) {
        const byte = buffer[state.offset++];

        result += (byte & 0x7f) * multiplier;

        if ((byte & 0x80) === 0) {
            return result;
        }

        multiplier *= 128;
    }
}

function zigZagDecode(value) {
    if (value % 2 === 0) {
        return value / 2;
    }

    return -((value + 1) / 2);
}

function readVarint(buffer, state) {
    return zigZagDecode(
        readUnsignedVarint(buffer, state)
    );
}


// ============================================================
// GRID DECODER
// ============================================================

function decodeLocalityIds(buffer) {
    const ids = [];

    const state = {
        offset: 0
    };

    let previous = 0;

    while (state.offset < buffer.length) {
        const delta = readUnsignedVarint(
            buffer,
            state
        );

        const id = previous + delta;

        ids.push(id);

        previous = id;
    }

    return ids;
}


// ============================================================
// GEOMETRY DECODER
// ============================================================

function decodeRing(buffer, state) {
    const pointCount = readUnsignedVarint(
        buffer,
        state
    );

    const points = new Array(pointCount);

    let x = 0;
    let y = 0;

    for (let i = 0; i < pointCount; i++) {
        if (i === 0) {
            x = readVarint(buffer, state);
            y = readVarint(buffer, state);
        } else {
            x += readVarint(buffer, state);
            y += readVarint(buffer, state);
        }

        points[i] = [
            x / SCALE,
            y / SCALE
        ];
    }

    return points;
}

function decodePolygon(buffer, state) {
    const ringCount = readUnsignedVarint(
        buffer,
        state
    );

    const rings = new Array(ringCount);

    for (let i = 0; i < ringCount; i++) {
        rings[i] = decodeRing(
            buffer,
            state
        );
    }

    return rings;
}

function decodeGeometry(buffer) {
    const state = {
        offset: 0
    };

    const polygonCount = readUnsignedVarint(
        buffer,
        state
    );

    const polygons = new Array(polygonCount);

    for (let i = 0; i < polygonCount; i++) {
        polygons[i] = decodePolygon(
            buffer,
            state
        );
    }

    return polygons;
}


// ============================================================
// POINT IN RING
// ============================================================

function pointInRing(lon, lat, ring) {
    let inside = false;

    for (
        let i = 0, j = ring.length - 1;
        i < ring.length;
        j = i++
    ) {
        const xi = ring[i][0];
        const yi = ring[i][1];

        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects =
            ((yi > lat) !== (yj > lat)) &&
            (
                lon <
                (xj - xi) *
                (lat - yi) /
                (yj - yi) +
                xi
            );

        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}


// ============================================================
// POINT IN POLYGON
// ============================================================

function pointInPolygon(lon, lat, rings) {
    if (rings.length === 0) {
        return false;
    }

    // First ring = exterior.
    if (!pointInRing(lon, lat, rings[0])) {
        return false;
    }

    // Remaining rings = holes.
    for (let i = 1; i < rings.length; i++) {
        if (pointInRing(lon, lat, rings[i])) {
            return false;
        }
    }

    return true;
}

function pointInGeometry(lon, lat, polygons) {
    for (const polygon of polygons) {
        if (pointInPolygon(lon, lat, polygon)) {
            return true;
        }
    }

    return false;
}

// ============================================================
// MATCH SELECTION
// ============================================================

function selectSmallest(matches) {
    if (matches.length === 0) {
        return null;
    }

    return matches.reduce((smallest, match) =>
        match.area < smallest.area
            ? match
            : smallest
    );
}

const SMART_DETAIL_SUBTYPES = new Set([
    "microhood",
    "neighborhood",
    "macrohood",
    "borough"
]);
const SMART_CITY_SIZED_COUNTY_MIN_AREA = 0.005;
const SMART_LOCAL_NAME_COUNTY_AREA_MIN_MULTIPLIER = 10;
const SMART_LOCAL_NAME_COUNTY_AREA_MAX_MULTIPLIER = 40;

function selectLargest(matches) {
    return matches.reduce((largest, match) =>
        match.area > largest.area
            ? match
            : largest
    );
}

function normalizeSmartName(name) {
    return (name ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function regionReferencesCountyName(region, county) {
    const countyNames = [county.localName, county.englishName]
        .map(normalizeSmartName)
        .filter(name => name.length >= 3);
    const regionNames = [region.localName, region.englishName]
        .map(normalizeSmartName)
        .filter(Boolean);

    return countyNames.some(countyName =>
        regionNames.some(regionName => regionName.includes(countyName))
    );
}

function selectSmartFallback(matches) {
    // A country alone is never a useful Smart result. It remains a valid
    // polygon match for diagnostics and for Smallest mode.
    const nonCountry = matches.filter(
        match => match.subtype !== "country"
    );

    if (nonCountry.length === 0) {
        return null;
    }

    // Neighborhood-scale divisions are useful only when there is no broader
    // human-recognizable division at this coordinate.
    const broaderDivisions = nonCountry.filter(
        match => !SMART_DETAIL_SUBTYPES.has(match.subtype)
    );

    if (broaderDivisions.length === 0) {
        return selectSmallest(nonCountry);
    }

    // Regions are usually too broad for a useful Smart result. Keep them as
    // a fallback for city-regions such as Istanbul, where the only county is
    // a very small inner-city district (for example Fatih).
    const regions = broaderDivisions.filter(
        match => match.subtype === "region"
    );
    const nonRegions = broaderDivisions.filter(
        match => match.subtype !== "region"
    );
    const counties = nonRegions.filter(
        match =>
            match.subtype === "county" &&
            match.adminLevel === 2
    );

    if (counties.length > 0) {
        const county = selectLargest(counties);
        const countyIdentifiesRegion = regions.some(region =>
            regionReferencesCountyName(region, county)
        );

        if (
            regions.length === 0 ||
            county.area >= SMART_CITY_SIZED_COUNTY_MIN_AREA ||
            countyIdentifiesRegion
        ) {
            return county;
        }

        return selectLargest(regions);
    }

    if (nonRegions.length > 0) {
        return selectSmallest(nonRegions);
    }

    return selectLargest(regions);
}

function selectSmart(matches) {
    if (matches.length === 0) {
        return null;
    }

    const localities = matches.filter(
        match => match.subtype === "locality"
    );

    // With no locality, skip neighborhood-scale and country divisions when a
    // broader useful division is available.
    if (localities.length === 0) {
        return selectSmartFallback(matches);
    }

    // When nested localities overlap, an English/common name is a strong
    // signal for the city a person would expect to see. Fall back to area
    // only when none of the locality records has one.
    const namedLocalities = localities.filter(
        match => match.englishName
    );
    const baseline = selectLargest(
        namedLocalities.length > 0 ? namedLocalities : localities
    );

    // Counties are deliberately only conservative overrides. This is the
    // behavior validated by geocoder-new.js: it yields Cologne without
    // turning New York County or Sydney's council into the default place.
    const counties = matches.filter(match =>
        match.subtype === "county" &&
        match.adminLevel === 2
    );

    if (counties.length === 0) {
        return baseline;
    }

    const overrides = counties.filter(county => {
        if (baseline.englishName) {
            return false;
        }

        const hasEnglishNameOverride =
            county.englishName &&
            county.area >= baseline.area * 4;
        const hasMuchLargerLocalNameOverride =
            county.localName &&
            county.localName !== baseline.localName &&
            county.area >=
                baseline.area * SMART_LOCAL_NAME_COUNTY_AREA_MIN_MULTIPLIER &&
            county.area <=
                baseline.area * SMART_LOCAL_NAME_COUNTY_AREA_MAX_MULTIPLIER;

        // Some countries use the county record as the city boundary but do
        // not provide a separate English name. This catches city-centre
        // localities such as Innenstadt Nord -> Dortmund. A much larger
        // municipality county is more likely to be a parent area, so it
        // leaves a small locality such as Terherne as the Smart result.
        return hasEnglishNameOverride || hasMuchLargerLocalNameOverride;
    });

    return overrides.length === 0
        ? baseline
        : selectSmallest(overrides);
}


// ============================================================
// GEOCODER
// ============================================================

class OfflineGeocoder {

    constructor(databasePath) {
        this.placesDB = new Database(databasePath, {
            readonly: true,
            fileMustExist: true
        });

        this.getGridCell = this.placesDB.prepare(`
            SELECT locality_ids
            FROM grid
            WHERE cell_id = ?
        `);

        this.getLocality = this.placesDB.prepare(`
            SELECT
                id,
                local_name,
                english_name,
                country,
                region,
                subtype,
                admin_level,
                area,
                min_lon,
                max_lon,
                min_lat,
                max_lat
            FROM localities
            WHERE id = ?
        `);

        this.getLocalityGeometry = this.placesDB.prepare(
            "SELECT geometry FROM localities WHERE id = ?"
        );
    }


    reverseGeocode(latitude, longitude, options = {}) {
        const mode = options.mode ?? "smart";

        if (mode !== "smart" && mode !== "smallest") {
            throw new Error("Invalid geocoding mode: " + mode);
        }

        // Invalid EXIF values must never stall callers. The worker records
        // these as a resolved no-match.
        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return null;
        }


        // ----------------------------------------------------
        // 1. Calculate grid cell.
        // ----------------------------------------------------

        const cellId = gridCellId(
            longitude,
            latitude
        );


        // ----------------------------------------------------
        // 2. Get candidate locality IDs.
        // ----------------------------------------------------

        const cell = this.getGridCell.get(
            cellId
        );

        if (!cell) {
            return null;
        }


        const localityIds = decodeLocalityIds(
            cell.locality_ids
        );


        // ----------------------------------------------------
        // 3. Test actual polygons.
        // ----------------------------------------------------

        const matches = [];
        let bboxCandidates = 0;
        let geometryTests = 0;

        for (const id of localityIds) {

            const locality = this.getLocality.get(id);

            if (!locality) {
                continue;
            }

            // Bounds are stored alongside metadata so we do not load or
            // decode a geometry blob for clearly non-containing candidates.
            if (
                longitude < locality.min_lon ||
                longitude > locality.max_lon ||
                latitude < locality.min_lat ||
                latitude > locality.max_lat
            ) {
                continue;
            }

            bboxCandidates++;

            const geometryRow = this.getLocalityGeometry.get(id);
            if (!geometryRow) {
                continue;
            }

            geometryTests++;
            const geometry = decodeGeometry(geometryRow.geometry);

            if (pointInGeometry(longitude, latitude, geometry)) {
                matches.push({
                    id: locality.id,
                    localName: locality.local_name,
                    englishName: locality.english_name,
                    country: locality.country,
                    region: locality.region,
                    subtype: locality.subtype,
                    adminLevel: locality.admin_level,
                    area: locality.area
                });
            }
        }

        const selected =
            mode === "smallest"
                ? selectSmallest(matches)
                : selectSmart(matches);

        return {
            cellId,
            candidates: localityIds.length,
            bboxCandidates,
            geometryTests,
            matches,
            selected
        };
    }


    reverseGeocodeOne(latitude, longitude, options = {}) {
        return this.reverseGeocode(latitude, longitude, options)?.selected ?? null;
    }


    close() {
        this.placesDB.close();
    }
}


module.exports = {
    OfflineGeocoder
};
