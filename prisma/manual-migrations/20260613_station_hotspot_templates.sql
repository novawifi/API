ALTER TABLE "Station"
  ADD COLUMN IF NOT EXISTS "hotspotTemplateMode" TEXT,
  ADD COLUMN IF NOT EXISTS "hotspotTemplateName" TEXT;
