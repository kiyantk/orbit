const LOCATION_GEOCODER_VERSION = "polygon-divisions-v8";
const LOCATION_METADATA_TABLE = "location_index_metadata";

function normalizeLocationSelectionMode(mode) {
  return mode === "smallest" ? "smallest" : "smart";
}

function getLocationGeocoderVersion(mode) {
  return `${LOCATION_GEOCODER_VERSION}:${normalizeLocationSelectionMode(mode)}`;
}

module.exports = {
  LOCATION_GEOCODER_VERSION,
  LOCATION_METADATA_TABLE,
  normalizeLocationSelectionMode,
  getLocationGeocoderVersion,
};
