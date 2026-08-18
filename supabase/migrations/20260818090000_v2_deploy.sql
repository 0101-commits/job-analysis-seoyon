-- v2 실배포 준비: 스키마 확장 + 트랜잭션 저장 RPC + 정정 요청 + 계열사 정리
-- 기획서(9c804b14) 스키마 변경 총괄 반영. 적용 대상: dlpfgtpswcwhjvphechc

-- ── D2. 조사 범위 = 서연·서연이화. 서연탑메탈 제거 (참조 0건 확인 2026-08-18) ──
DELETE FROM public.survey_settings ss
WHERE ss.company_id IN (SELECT id FROM public.companies WHERE name = '서연탑메탈')
  AND NOT EXISTS (SELECT 1 FROM public.participants p WHERE p.company_id = ss.company_id);
DELETE FROM public.companies c
WHERE c.name = '서연탑메탈'
  AND NOT EXISTS (SELECT 1 FROM public.participants p WHERE p.company_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM public.responses r WHERE r.company_id = c.id);

-- ── A1. 허용 이메일 도메인 (빈 배열 = 제한 없음) ──
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS allowed_email_domains text[] NOT NULL DEFAULT '{}';

-- ── A2. 참여자: 조직 연결·태그·소프트 삭제 ──
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES public.org_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS participants_org_unit_idx ON public.participants (org_unit_id);

-- ── A8. 미진행 기준일 (계열사별) ──
ALTER TABLE public.survey_settings
  ADD COLUMN IF NOT EXISTS stale_days integer NOT NULL DEFAULT 7 CHECK (stale_days BETWEEN 1 AND 60);

-- ── U4. 예시: 공통(인사 기준) 플래그 + 직군 매칭 키 ──
ALTER TABLE public.example_library
  ADD COLUMN IF NOT EXISTS is_common boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS job_group_key text;
-- 기존 4카테고리 중 사무관리를 공통 기준 예시로 승격 (콘텐츠 보강은 앱 시드에서)
UPDATE public.example_library SET is_common = true WHERE category = '사무관리';

-- ── U6. 스킬: 특정 과업과 무관(직무 공통) 표시 ──
ALTER TABLE public.response_skills
  ADD COLUMN IF NOT EXISTS is_general boolean NOT NULL DEFAULT false;

-- ── U1. 기본정보 정정 요청 ──
CREATE TABLE IF NOT EXISTS public.info_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES public.participants(id) ON DELETE CASCADE,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{field, current, requested}]
  note text,
  status text NOT NULL DEFAULT '요청' CHECK (status IN ('요청', '처리완료', '반려')),
  admin_note text,
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS info_change_requests_status_idx ON public.info_change_requests (status, created_at DESC);
GRANT SELECT, INSERT ON public.info_change_requests TO authenticated;
GRANT ALL ON public.info_change_requests TO service_role;
ALTER TABLE public.info_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own requests" ON public.info_change_requests;
CREATE POLICY "own requests" ON public.info_change_requests
  FOR SELECT USING (
    participant_id IN (SELECT id FROM public.participants WHERE user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  );
DROP POLICY IF EXISTS "insert own request" ON public.info_change_requests;
CREATE POLICY "insert own request" ON public.info_change_requests
  FOR INSERT WITH CHECK (
    participant_id IN (SELECT id FROM public.participants WHERE user_id = auth.uid())
  );
DROP POLICY IF EXISTS "admins update requests" ON public.info_change_requests;
CREATE POLICY "admins update requests" ON public.info_change_requests
  FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));
GRANT UPDATE ON public.info_change_requests TO authenticated;

-- ── U2/U3. 트랜잭션 저장 RPC + 낙관적 락 ──
-- delete→insert 를 단일 트랜잭션으로. _expected 가 있고 responses.updated_at 과 다르면
-- 관리자 정정과의 충돌로 보고 예외를 던진다. 성공 시 새 updated_at 반환.
CREATE OR REPLACE FUNCTION public.save_tasks_tx(
  _response_id uuid,
  _tasks jsonb,
  _expected timestamptz DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _current timestamptz;
  _task jsonb;
  _act jsonb;
  _task_id uuid;
  _new timestamptz;
BEGIN
  IF NOT public.owns_response(_response_id, true) THEN
    RAISE EXCEPTION 'not_editable' USING ERRCODE = '42501';
  END IF;
  SELECT updated_at INTO _current FROM public.responses WHERE id = _response_id FOR UPDATE;
  IF _expected IS NOT NULL AND _current IS DISTINCT FROM _expected THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.response_tasks WHERE response_id = _response_id;

  FOR _task IN SELECT * FROM jsonb_array_elements(COALESCE(_tasks, '[]'::jsonb)) LOOP
    _task_id := COALESCE((_task->>'id')::uuid, gen_random_uuid());
    INSERT INTO public.response_tasks
      (id, response_id, seq, name, importance, authority, transferable, is_key, improve_type, improve_note)
    VALUES (
      _task_id, _response_id,
      COALESCE((_task->>'seq')::integer, 0),
      _task->>'name',
      (_task->>'importance')::integer,
      NULLIF(_task->>'authority', ''),
      (_task->>'transferable')::boolean,
      COALESCE((_task->>'is_key')::boolean, false),
      NULLIF(_task->>'improve_type', ''),
      NULLIF(_task->>'improve_note', '')
    );
    FOR _act IN SELECT * FROM jsonb_array_elements(COALESCE(_task->'activities', '[]'::jsonb)) LOOP
      INSERT INTO public.response_activities (task_id, seq, name)
      VALUES (_task_id, COALESCE((_act->>'seq')::integer, 0), _act->>'name');
    END LOOP;
  END LOOP;

  UPDATE public.responses SET updated_at = now() WHERE id = _response_id
  RETURNING updated_at INTO _new;
  RETURN _new;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_skills_tx(
  _response_id uuid,
  _skills jsonb,
  _expected timestamptz DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _current timestamptz;
  _skill jsonb;
  _new timestamptz;
BEGIN
  IF NOT public.owns_response(_response_id, true) THEN
    RAISE EXCEPTION 'not_editable' USING ERRCODE = '42501';
  END IF;
  SELECT updated_at INTO _current FROM public.responses WHERE id = _response_id FOR UPDATE;
  IF _expected IS NOT NULL AND _current IS DISTINCT FROM _expected THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.response_skills WHERE response_id = _response_id;

  FOR _skill IN SELECT * FROM jsonb_array_elements(COALESCE(_skills, '[]'::jsonb)) LOOP
    INSERT INTO public.response_skills
      (id, response_id, name, ksao, hard_soft, description, related_task_ids, is_general, ai_draft)
    VALUES (
      COALESCE((_skill->>'id')::uuid, gen_random_uuid()),
      _response_id,
      _skill->>'name',
      NULLIF(_skill->>'ksao', ''),
      NULLIF(_skill->>'hard_soft', ''),
      NULLIF(_skill->>'description', ''),
      COALESCE(
        (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(_skill->'related_task_ids', '[]'::jsonb)) AS x
         WHERE EXISTS (SELECT 1 FROM public.response_tasks t WHERE t.id = x::uuid AND t.response_id = _response_id)),
        '{}'::uuid[]
      ),
      COALESCE((_skill->>'is_general')::boolean, false),
      COALESCE((_skill->>'ai_draft')::boolean, false)
    );
  END LOOP;

  UPDATE public.responses SET updated_at = now() WHERE id = _response_id
  RETURNING updated_at INTO _new;
  RETURN _new;
END;
$$;

REVOKE ALL ON FUNCTION public.save_tasks_tx(uuid, jsonb, timestamptz) FROM anon, public;
REVOKE ALL ON FUNCTION public.save_skills_tx(uuid, jsonb, timestamptz) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.save_tasks_tx(uuid, jsonb, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_skills_tx(uuid, jsonb, timestamptz) TO authenticated;

-- ── A6. 메일 이미지 저장소 ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('mail-assets', 'mail-assets', true)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "admins manage mail assets" ON storage.objects;
CREATE POLICY "admins manage mail assets" ON storage.objects
  FOR ALL USING (bucket_id = 'mail-assets' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'mail-assets' AND public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "public read mail assets" ON storage.objects;
CREATE POLICY "public read mail assets" ON storage.objects
  FOR SELECT USING (bucket_id = 'mail-assets');
