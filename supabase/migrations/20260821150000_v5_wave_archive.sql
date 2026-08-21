-- v5: allow archiving waves
ALTER TABLE public.survey_waves ADD COLUMN IF NOT EXISTS archived_at timestamptz;
