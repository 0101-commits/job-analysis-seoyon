-- v2.1 고도화: 직무분류 버전 관리(V6) + 제출 스냅샷(V15-1)
-- 기획서(9c804b14) v2.1 확정분. 적용 대상: dlpfgtpswcwhjvphechc

-- ── V6. 직무분류 버전 관리 ──
CREATE TABLE IF NOT EXISTS public.job_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  label text NOT NULL,
  note text,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_catalog_versions_created_idx ON public.job_catalog_versions (created_at DESC);
GRANT SELECT, INSERT, DELETE ON public.job_catalog_versions TO authenticated;
GRANT ALL ON public.job_catalog_versions TO service_role;
ALTER TABLE public.job_catalog_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins manage catalog versions" ON public.job_catalog_versions;
CREATE POLICY "admins manage catalog versions" ON public.job_catalog_versions
  FOR ALL USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ── V15-1. 제출 시점 스냅샷 (재제출 변경분 하이라이트) ──
CREATE TABLE IF NOT EXISTS public.submission_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.responses(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, seq)
);
GRANT SELECT ON public.submission_snapshots TO authenticated;
GRANT ALL ON public.submission_snapshots TO service_role;
ALTER TABLE public.submission_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read own or admin snapshots" ON public.submission_snapshots;
CREATE POLICY "read own or admin snapshots" ON public.submission_snapshots
  FOR SELECT USING (
    public.has_role(auth.uid(), 'admin')
    OR response_id IN (
      SELECT r.id FROM public.responses r
      JOIN public.participants p ON p.id = r.participant_id
      WHERE p.user_id = auth.uid()
    )
  );

-- 제출 시 서버가 현재 응답 전체를 payload 로 캡처 (클라이언트 위조 불가)
CREATE OR REPLACE FUNCTION public.snapshot_submission(_response_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _seq integer;
  _payload jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.responses r
      JOIN public.participants p ON p.id = r.participant_id
      WHERE r.id = _response_id AND p.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO _seq
  FROM public.submission_snapshots WHERE response_id = _response_id;

  SELECT jsonb_build_object(
    'response', to_jsonb(r) - 'id',
    'tasks', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(t) || jsonb_build_object(
          'activities', COALESCE((
            SELECT jsonb_agg(to_jsonb(a) ORDER BY a.seq)
            FROM public.response_activities a WHERE a.task_id = t.id
          ), '[]'::jsonb)
        ) ORDER BY t.seq)
      FROM public.response_tasks t WHERE t.response_id = r.id
    ), '[]'::jsonb),
    'skills', COALESCE((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name)
      FROM public.response_skills s WHERE s.response_id = r.id
    ), '[]'::jsonb),
    'requirements', COALESCE((
      SELECT jsonb_agg(to_jsonb(q))
      FROM public.response_requirements q WHERE q.response_id = r.id
    ), '[]'::jsonb)
  ) INTO _payload
  FROM public.responses r WHERE r.id = _response_id;

  IF _payload IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.submission_snapshots (response_id, seq, payload)
  VALUES (_response_id, _seq, _payload);
  RETURN _seq;
END;
$$;
REVOKE ALL ON FUNCTION public.snapshot_submission(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.snapshot_submission(uuid) TO authenticated;
