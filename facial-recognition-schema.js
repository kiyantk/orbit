// A pipeline version covers the detector, alignment behaviour, recognizer and
// quality gates. Changing it deliberately causes a fresh scan while retaining
// the schema needed to inspect existing gallery data.
const FACE_PIPELINE_VERSION = "antelopev2-glintr100-v1";
const FACE_EMBEDDING_VERSION = "antelopev2-glintr100";

const FACE_METADATA_TABLE = "face_index_metadata";
const FACE_SCAN_TABLE = "face_scans";
const FACE_TABLE = "faces";
const PEOPLE_TABLE = "people";
const FACE_ASSIGNMENT_TABLE = "face_person_assignments";
const PERSON_REPRESENTATIVE_TABLE = "person_representatives";

module.exports = {
  FACE_PIPELINE_VERSION,
  FACE_EMBEDDING_VERSION,
  FACE_METADATA_TABLE,
  FACE_SCAN_TABLE,
  FACE_TABLE,
  PEOPLE_TABLE,
  FACE_ASSIGNMENT_TABLE,
  PERSON_REPRESENTATIVE_TABLE,
};
