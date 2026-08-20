-- v3 기능 고도화 (기획안 2d02b200) 스키마
-- 적용 대상: dlpfgtpswcwhjvphechc
--
-- F1 메일 반송 수집 / F2 스케줄 실행 이력 / F3 자동 백업·복구 / F4 독려 규칙
-- F5 진행 리포트 설정 / F6 문의함 / F7 인터뷰 / F8 조사 차수
-- F10 재확인 일감화 / F12·F13 직무기술서 산출물·근거 / F16 품질 점수 / F17 AI 원장

-- ===========================================================================
-- F1. 메일 반송·재시도
-- ===========================================================================
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS mail_bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS mail_bounce_reason text;

ALTER TABLE public.mail_logs
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_event jsonb;

-- 상태에 '반송' 추가 (기존 CHECK 교체)
ALTER TABLE public.mail_logs DROP CONSTRAINT IF EXISTS mail_logs_status_check;
ALTER TABLE public.mail_logs
  ADD CONSTRAINT mail_logs_status_check
  CHECK (status IN ('성공', '실패', '시뮬레이션', '반송'));

-- ===========================================================================
-- F2. 스케줄 실행 이력 — "언제 돌았고 무엇을 했는지"를 화면에서 본다
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  status text NOT NULL DEFAULT '성공' CHECK (status IN ('성공', '실패', '건너뜀')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  duration_ms integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS cron_runs_job_idx ON public.cron_runs (job, started_at DESC);
GRANT SELECT ON public.cron_runs TO authenticated;
GRANT ALL ON public.cron_runs TO service_role;
ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins view cron runs" ON public.cron_runs;
CREATE POLICY "admins view cron runs" ON public.cron_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ===========================================================================
-- F3. 자동 백업 — 파일은 Storage, 목록은 여기
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT '자동' CHECK (kind IN ('자동', '수동', '반영전')),
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  size_bytes bigint,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_created_idx ON public.backups (created_at DESC);
GRANT SELECT ON public.backups TO authenticated;
GRANT ALL ON public.backups TO service_role;
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins view backups" ON public.backups;
CREATE POLICY "admins view backups" ON public.backups
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- 비공개 버킷. 서버(service_role)만 읽고 쓴다.
INSERT INTO storage.buckets (id, name, public)
VALUES ('backups', 'backups', false)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- F4. 독려 규칙 — 상태 x 정체일
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.reminder_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('미로그인', '작성정체', '반려미수정', '마감임박')),
  days integer NOT NULL DEFAULT 3 CHECK (days BETWEEN 1 AND 60),
  template_id uuid REFERENCES public.mail_templates(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT false,
  daily_cap integer NOT NULL DEFAULT 200 CHECK (daily_cap BETWEEN 1 AND 2000),
  last_run_at timestamptz,
  last_sent_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminder_rules_company_idx ON public.reminder_rules (company_id, enabled);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminder_rules TO authenticated;
GRANT ALL ON public.reminder_rules TO service_role;
ALTER TABLE public.reminder_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins manage reminder rules" ON public.reminder_rules;
CREATE POLICY "admins manage reminder rules" ON public.reminder_rules
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP TRIGGER IF EXISTS reminder_rules_updated_at ON public.reminder_rules;
CREATE TRIGGER reminder_rules_updated_at BEFORE UPDATE ON public.reminder_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 하루 1회 가드용: 같은 규칙이 같은 날 두 번 돌지 않게 실행 기록을 남긴다.
CREATE TABLE IF NOT EXISTS public.reminder_rule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.reminder_rules(id) ON DELETE CASCADE,
  run_date date NOT NULL DEFAULT current_date,
  sent_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, run_date)
);
GRANT SELECT ON public.reminder_rule_runs TO authenticated;
GRANT ALL ON public.reminder_rule_runs TO service_role;
ALTER TABLE public.reminder_rule_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins view rule runs" ON public.reminder_rule_runs;
CREATE POLICY "admins view rule runs" ON public.reminder_rule_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ===========================================================================
-- F5. 진행 리포트 자동 발송 설정 + F3 보존 기간 (전역 1행)
-- ===========================================================================
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS report_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS report_weekday integer NOT NULL DEFAULT 1 CHECK (report_weekday BETWEEN 0 AND 6),
  ADD COLUMN IF NOT EXISTS report_recipients text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS backup_retention_days integer NOT NULL DEFAULT 30 CHECK (backup_retention_days BETWEEN 7 AND 365),
  ADD COLUMN IF NOT EXISTS mail_daily_cap integer NOT NULL DEFAULT 500 CHECK (mail_daily_cap BETWEEN 1 AND 20000);

-- ===========================================================================
-- F6. 문의함
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES public.participants(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT '기타' CHECK (category IN ('직무없음', '항목이해', '접속문제', '기타')),
  body text NOT NULL,
  status text NOT NULL DEFAULT '접수' CHECK (status IN ('접수', '답변완료')),
  answer text,
  answered_by uuid,
  answered_at timestamptz,
  answer_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiries_status_idx ON public.inquiries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS inquiries_participant_idx ON public.inquiries (participant_id);
GRANT SELECT, INSERT ON public.inquiries TO authenticated;
GRANT UPDATE ON public.inquiries TO authenticated;
GRANT ALL ON public.inquiries TO service_role;
ALTER TABLE public.inquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own inquiries" ON public.inquiries;
CREATE POLICY "own inquiries" ON public.inquiries
  FOR SELECT TO authenticated USING (
    participant_id IN (SELECT id FROM public.participants WHERE user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  );
DROP POLICY IF EXISTS "insert own inquiry" ON public.inquiries;
CREATE POLICY "insert own inquiry" ON public.inquiries
  FOR INSERT TO authenticated WITH CHECK (
    participant_id IN (SELECT id FROM public.participants WHERE user_id = auth.uid())
  );
DROP POLICY IF EXISTS "admins answer inquiries" ON public.inquiries;
CREATE POLICY "admins answer inquiries" ON public.inquiries
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ===========================================================================
-- F7. 소수 직무 인터뷰
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.responses(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES public.participants(id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  interviewer text,
  status text NOT NULL DEFAULT '예정' CHECK (status IN ('예정', '완료', '취소')),
  memo text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interviews_response_idx ON public.interviews (response_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.interviews TO authenticated;
GRANT ALL ON public.interviews TO service_role;
ALTER TABLE public.interviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins manage interviews" ON public.interviews;
CREATE POLICY "admins manage interviews" ON public.interviews
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP TRIGGER IF EXISTS interviews_updated_at ON public.interviews;
CREATE TRIGGER interviews_updated_at BEFORE UPDATE ON public.interviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- F8. 조사 차수
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.survey_waves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  kind text NOT NULL DEFAULT '보완' CHECK (kind IN ('1차', '보완', '신규입사')),
  deadline date,
  reminder_days integer[] NOT NULL DEFAULT '{7,3,1}',
  status text NOT NULL DEFAULT '준비' CHECK (status IN ('준비', '진행', '마감')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, seq)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.survey_waves TO authenticated;
GRANT ALL ON public.survey_waves TO service_role;
ALTER TABLE public.survey_waves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signed in users view waves" ON public.survey_waves;
CREATE POLICY "signed in users view waves" ON public.survey_waves
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admins manage waves" ON public.survey_waves;
CREATE POLICY "admins manage waves" ON public.survey_waves
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP TRIGGER IF EXISTS survey_waves_updated_at ON public.survey_waves;
CREATE TRIGGER survey_waves_updated_at BEFORE UPDATE ON public.survey_waves
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS wave_id uuid REFERENCES public.survey_waves(id) ON DELETE SET NULL;
ALTER TABLE public.responses
  ADD COLUMN IF NOT EXISTS wave_id uuid REFERENCES public.survey_waves(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS participants_wave_idx ON public.participants (wave_id);
CREATE INDEX IF NOT EXISTS responses_wave_idx ON public.responses (wave_id);

-- 계열사별 1차 차수를 만들고 기존 참여자·응답을 전부 여기로 붙인다(집계 연속성 유지).
INSERT INTO public.survey_waves (company_id, seq, name, kind, deadline, status)
SELECT c.id, 1, '1차 조사', '1차', ss.deadline, '진행'
FROM public.companies c
LEFT JOIN public.survey_settings ss ON ss.company_id = c.id
WHERE NOT EXISTS (SELECT 1 FROM public.survey_waves w WHERE w.company_id = c.id AND w.seq = 1);

UPDATE public.participants p
SET wave_id = w.id
FROM public.survey_waves w
WHERE w.company_id = p.company_id AND w.seq = 1 AND p.wave_id IS NULL;

UPDATE public.responses r
SET wave_id = w.id
FROM public.survey_waves w
WHERE w.company_id = r.company_id AND w.seq = 1 AND r.wave_id IS NULL;

-- ===========================================================================
-- F10. 변경 재확인 일감화 / F16. 품질 점수
-- ===========================================================================
ALTER TABLE public.responses
  ADD COLUMN IF NOT EXISTS recheck_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recheck_reason text,
  ADD COLUMN IF NOT EXISTS recheck_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS recheck_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS quality_score integer CHECK (quality_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS responses_recheck_idx ON public.responses (recheck_required)
  WHERE recheck_required;

-- 응답자는 재확인을 해제만 할 수 있고(확인 처리), 품질 판정은 손대지 못한다.
CREATE OR REPLACE FUNCTION public.guard_response_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;
  NEW.reviewed_by := OLD.reviewed_by;
  NEW.reviewed_at := OLD.reviewed_at;
  NEW.participant_id := OLD.participant_id;
  NEW.company_id := OLD.company_id;
  NEW.wave_id := OLD.wave_id;
  NEW.quality_score := OLD.quality_score;
  NEW.quality_flags := OLD.quality_flags;
  NEW.quality_checked_at := OLD.quality_checked_at;
  NEW.recheck_reason := OLD.recheck_reason;
  NEW.recheck_notified_at := OLD.recheck_notified_at;
  -- 재확인 플래그는 세우지 못하고 내리기만 가능
  IF NEW.recheck_required AND NOT OLD.recheck_required THEN
    NEW.recheck_required := OLD.recheck_required;
    NEW.recheck_cleared_at := OLD.recheck_cleared_at;
  END IF;
  IF NEW.status NOT IN (OLD.status, 'draft', 'submitted') THEN
    RAISE EXCEPTION '허용되지 않은 상태 전이입니다: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guard_response_update() FROM anon, authenticated, public;
DROP TRIGGER IF EXISTS responses_guard_update ON public.responses;
CREATE TRIGGER responses_guard_update BEFORE UPDATE ON public.responses
  FOR EACH ROW EXECUTE FUNCTION public.guard_response_update();

-- ===========================================================================
-- F12·F13. 직무기술서 산출물 + 근거 추적
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.job_descriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_name text NOT NULL,
  job_group text,
  job_series text,
  definition text,
  mission text,
  tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  knowledge jsonb NOT NULL DEFAULT '[]'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  attitudes jsonb NOT NULL DEFAULT '[]'::jsonb,
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- F13: 항목별 출처 { "tasks.0": ["<response_id>", ...], "definition": [...] }
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 사람이 고친 필드. 재생성 시 이 필드는 AI 결과로 덮지 않는다.
  edited_fields text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT '초안' CHECK (status IN ('초안', '검토중', '확정')),
  catalog_version_id uuid REFERENCES public.job_catalog_versions(id) ON DELETE SET NULL,
  response_count integer NOT NULL DEFAULT 0,
  generated_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, job_name)
);
CREATE INDEX IF NOT EXISTS job_descriptions_status_idx ON public.job_descriptions (company_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_descriptions TO authenticated;
GRANT ALL ON public.job_descriptions TO service_role;
ALTER TABLE public.job_descriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins manage job descriptions" ON public.job_descriptions;
CREATE POLICY "admins manage job descriptions" ON public.job_descriptions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP TRIGGER IF EXISTS job_descriptions_updated_at ON public.job_descriptions;
CREATE TRIGGER job_descriptions_updated_at BEFORE UPDATE ON public.job_descriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.job_description_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_description_id uuid NOT NULL REFERENCES public.job_descriptions(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 1,
  snapshot jsonb NOT NULL,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_description_id, seq)
);
GRANT SELECT, INSERT ON public.job_description_versions TO authenticated;
GRANT ALL ON public.job_description_versions TO service_role;
ALTER TABLE public.job_description_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins manage jd versions" ON public.job_description_versions;
CREATE POLICY "admins manage jd versions" ON public.job_description_versions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 저장 직전 상태를 버전으로 남기고 seq 를 자동으로 매긴다.
CREATE OR REPLACE FUNCTION public.snapshot_job_description(_id uuid, _note text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_seq integer;
  v_row public.job_descriptions;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION '권한이 없습니다.';
  END IF;
  SELECT * INTO v_row FROM public.job_descriptions WHERE id = _id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION '직무기술서를 찾을 수 없습니다.';
  END IF;
  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq
  FROM public.job_description_versions WHERE job_description_id = _id;
  INSERT INTO public.job_description_versions (job_description_id, seq, snapshot, note, created_by)
  VALUES (_id, v_seq, to_jsonb(v_row), _note, auth.uid());
  RETURN v_seq;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.snapshot_job_description(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.snapshot_job_description(uuid, text) TO authenticated;

-- ===========================================================================
-- F17. AI 사용 원장
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.ai_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature text NOT NULL,
  target text,
  status text NOT NULL DEFAULT '성공' CHECK (status IN ('성공', '실패')),
  model text,
  prompt_chars integer,
  output_chars integer,
  duration_ms integer,
  error_message text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_feature_idx ON public.ai_calls (feature, created_at DESC);
GRANT SELECT ON public.ai_calls TO authenticated;
GRANT ALL ON public.ai_calls TO service_role;
ALTER TABLE public.ai_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins view ai calls" ON public.ai_calls;
CREATE POLICY "admins view ai calls" ON public.ai_calls
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
