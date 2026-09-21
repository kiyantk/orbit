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
const MANUAL_PERSON_TABLE = "manual_people";
const MANUAL_PERSON_FACE_TABLE = "manual_person_faces";
const PERSON_EXCLUSION_TABLE = "manual_person_exclusions";
const FACE_SUGGESTION_TABLE = "face_match_suggestions";
const IGNORED_FACE_TABLE = "ignored_person_faces";
const HIDDEN_MANUAL_PERSON_TABLE = "hidden_manual_people";

module.exports = {
  FACE_PIPELINE_VERSION,
  FACE_EMBEDDING_VERSION,
  FACE_METADATA_TABLE,
  FACE_SCAN_TABLE,
  FACE_TABLE,
  PEOPLE_TABLE,
  FACE_ASSIGNMENT_TABLE,
  PERSON_REPRESENTATIVE_TABLE,
  MANUAL_PERSON_TABLE,
  MANUAL_PERSON_FACE_TABLE,
  PERSON_EXCLUSION_TABLE,
  FACE_SUGGESTION_TABLE,
  IGNORED_FACE_TABLE,
  HIDDEN_MANUAL_PERSON_TABLE,
};
