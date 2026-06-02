-- Remap legacy `gadgetbridge` source rows after the Gadgetbridge importer was
-- removed. Its `SourceKind::Gadgetbridge` variant no longer exists, so existing
-- rows with kind='gadgetbridge' (from past Gadgetbridge DB imports) fail to
-- deserialize and 500 any endpoint that reads sources. That data arrived via a
-- DB/file import, so `file_import` is its correct home. Idempotent.
UPDATE sources SET kind = 'file_import' WHERE kind = 'gadgetbridge';
