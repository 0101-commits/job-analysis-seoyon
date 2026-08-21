-- v4: 발송을 차수에 귀속시킨다
ALTER TABLE public.mail_batches
  ADD COLUMN IF NOT EXISTS wave_id uuid REFERENCES public.survey_waves(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mail_batches_wave ON public.mail_batches(wave_id);
