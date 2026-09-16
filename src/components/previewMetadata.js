export const PREVIEW_METADATA_FIELDS = [
  { id: "filename", label: "Filename" },
  { id: "size", label: "Size" },
  { id: "type", label: "Type" },
  { id: "taken", label: "Taken" },
  { id: "device", label: "Device" },
  { id: "resolution", label: "Resolution" },
  { id: "duration", label: "Duration" },
  { id: "location", label: "Location" },
  { id: "place", label: "Place" },
  { id: "country", label: "Country" },
  { id: "lens", label: "Lens" },
  { id: "iso", label: "ISO" },
  { id: "software", label: "Software" },
  { id: "megapixels", label: "Megapixels" },
  { id: "exposure", label: "Exposure" },
  { id: "colorSpace", label: "Color Space" },
  { id: "flash", label: "Flash" },
  { id: "aperture", label: "Aperture" },
  { id: "focalLength", label: "Focal Length" },
  { id: "timeOffset", label: "Time Offset" },
  { id: "make", label: "Make" },
  { id: "age", label: "Age" },
  { id: "modifiedAt", label: "Modified At" },
  { id: "createdAt", label: "Created At" },
  { id: "path", label: "Path" },
  { id: "similarity", label: "Similarity" },
  { id: "id", label: "ID" },
  { id: "tags", label: "Tags" },
];

export const DEFAULT_PREVIEW_METADATA_FIELDS = PREVIEW_METADATA_FIELDS.map(
  ({ id }) => id,
);

export function isPreviewMetadataFieldVisible(settings, field) {
  return (
    !Array.isArray(settings?.previewMetadataFields) ||
    settings.previewMetadataFields.includes(field)
  );
}
