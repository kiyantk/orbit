// v2 corrects coordinate mapping for EXIF-rotated photos and retries images
// that v1 marked complete after an invalid Sharp crop.
const OCR_PIPELINE_VERSION = "ocr-v2";
const OCR_METADATA_TABLE = "ocr_index_metadata";
const OCR_INDEX_TABLE = "ocr_index";
const OCR_FTS_TABLE = "ocr_index_fts";

module.exports = {
  OCR_PIPELINE_VERSION,
  OCR_METADATA_TABLE,
  OCR_INDEX_TABLE,
  OCR_FTS_TABLE,
};
