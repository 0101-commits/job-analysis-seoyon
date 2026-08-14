-- P3~P5: AI 제안 루프 + 마스터 데이터(조직/직무 카탈로그/직무분장표)

-- 1. AI 제안 (route A: 관리자 직접 반영 / route B: 응답자 확인 요청)
CREATE TABLE public.ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.responses(id) ON DELETE CASCADE,
  target text NOT NULL,
  original_value text,
  suggested_value text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('오타', '자동채움', '병합', '부실보완')),
  route text NOT NULL CHECK (route IN ('A', 'B')),
  status text NOT NULL DEFAULT '제안' CHECK (status IN ('제안', '요청중', '수락', '수정', '거절', '확정')),
  respondent_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_suggestions_response_idx ON public.ai_suggestions (response_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_suggestions TO authenticated;
GRANT ALL ON public.ai_suggestions TO service_role;
ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;

-- 2. 조직 구조
CREATE TABLE public.org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.org_units(id) ON DELETE CASCADE,
  name text NOT NULL,
  level text,
  sort integer NOT NULL DEFAULT 0
);
CREATE INDEX org_units_company_idx ON public.org_units (company_id, parent_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_units TO authenticated;
GRANT ALL ON public.org_units TO service_role;
ALTER TABLE public.org_units ENABLE ROW LEVEL SECURITY;

-- 3. 표준 직무 카탈로그 (계열사 공통, company_ids 로 적용 범위 표기)
CREATE TABLE public.job_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_group text NOT NULL,
  job_series text NOT NULL,
  job_name text NOT NULL,
  definition text,
  company_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (job_group, job_series, job_name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_catalog TO authenticated;
GRANT ALL ON public.job_catalog TO service_role;
ALTER TABLE public.job_catalog ENABLE ROW LEVEL SECURITY;

-- 4. 직무분장표 업로드본
CREATE TABLE public.duty_charts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  org_name text NOT NULL,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX duty_charts_company_idx ON public.duty_charts (company_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.duty_charts TO authenticated;
GRANT ALL ON public.duty_charts TO service_role;
ALTER TABLE public.duty_charts ENABLE ROW LEVEL SECURITY;

-- RLS 정책
-- ai_suggestions: 응답자는 확인 요청된 건만 보고, '요청중' 상태에서만 결정할 수 있다.
-- (수락/수정/거절 로 전이해야 하므로 WITH CHECK 은 소유 여부만 본다)
CREATE POLICY "owners view requested suggestions" ON public.ai_suggestions
  FOR SELECT TO authenticated
  USING (public.owns_response(response_id) AND status IN ('요청중', '수락', '수정', '거절'));
CREATE POLICY "owners decide requested suggestions" ON public.ai_suggestions
  FOR UPDATE TO authenticated
  USING (public.owns_response(response_id) AND status = '요청중')
  WITH CHECK (public.owns_response(response_id));
CREATE POLICY "admins manage suggestions" ON public.ai_suggestions
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 마스터 데이터: 사내 공개 정보이므로 로그인 사용자는 모두 조회, 편집은 관리자만
CREATE POLICY "signed in users view org units" ON public.org_units
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage org units" ON public.org_units
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "signed in users view job catalog" ON public.job_catalog
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage job catalog" ON public.job_catalog
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "signed in users view duty charts" ON public.duty_charts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage duty charts" ON public.duty_charts
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
