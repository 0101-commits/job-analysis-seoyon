-- P2 조사 마법사 코어 스키마
-- responses(1) → response_tasks(N) → response_activities(N)
--              → response_skills(N), response_requirements(1), review_comments(N)

-- 1. 응답 본문
CREATE TABLE public.responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL UNIQUE REFERENCES public.participants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_group text,
  job_series text,
  job_name text,
  definition text,
  mission text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'rejected', 'approved')),
  current_step integer NOT NULL DEFAULT 1,
  coverage_pct text CHECK (coverage_pct IN ('0-25', '26-50', '51-75', '76-100')),
  missed_note text,
  pain_note text,
  onboarding_done boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX responses_company_idx ON public.responses (company_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.responses TO authenticated;
GRANT ALL ON public.responses TO service_role;
ALTER TABLE public.responses ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER responses_updated_at BEFORE UPDATE ON public.responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. 과업
CREATE TABLE public.response_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.responses(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0,
  name text NOT NULL,
  importance integer CHECK (importance BETWEEN 1 AND 5),
  authority text CHECK (authority IN ('D', 'R', 'O', 'S')),
  transferable boolean,
  is_key boolean NOT NULL DEFAULT false,
  improve_type text CHECK (improve_type IN ('삭제', '통폐합', '빈도감소', '하위자위양', '타부서이관', '강화')),
  improve_note text
);
CREATE INDEX response_tasks_response_idx ON public.response_tasks (response_id, seq);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.response_tasks TO authenticated;
GRANT ALL ON public.response_tasks TO service_role;
ALTER TABLE public.response_tasks ENABLE ROW LEVEL SECURITY;

-- 3. 활동
CREATE TABLE public.response_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.response_tasks(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0,
  name text NOT NULL
);
CREATE INDEX response_activities_task_idx ON public.response_activities (task_id, seq);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.response_activities TO authenticated;
GRANT ALL ON public.response_activities TO service_role;
ALTER TABLE public.response_activities ENABLE ROW LEVEL SECURITY;

-- 4. 스킬
CREATE TABLE public.response_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.responses(id) ON DELETE CASCADE,
  name text NOT NULL,
  ksao text CHECK (ksao IN ('K', 'S', 'A')),
  hard_soft text CHECK (hard_soft IN ('Hard', 'Soft')),
  description text,
  related_task_ids uuid[] NOT NULL DEFAULT '{}',
  ai_draft boolean NOT NULL DEFAULT false
);
CREATE INDEX response_skills_response_idx ON public.response_skills (response_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.response_skills TO authenticated;
GRANT ALL ON public.response_skills TO service_role;
ALTER TABLE public.response_skills ENABLE ROW LEVEL SECURITY;

-- 5. 자격요건
CREATE TABLE public.response_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL UNIQUE REFERENCES public.responses(id) ON DELETE CASCADE,
  education text CHECK (education IN ('중졸이하', '고졸', '전문대졸', '학사', '석사급', '박사급이상', '기준없음')),
  majors_required text,
  majors_preferred text,
  licenses jsonb NOT NULL DEFAULT '[]'::jsonb,
  languages jsonb NOT NULL DEFAULT '[]'::jsonb,
  trainings text,
  proficiency text,
  ai_draft boolean NOT NULL DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.response_requirements TO authenticated;
GRANT ALL ON public.response_requirements TO service_role;
ALTER TABLE public.response_requirements ENABLE ROW LEVEL SECURITY;

-- 6. 검토 코멘트
CREATE TABLE public.review_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.responses(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  step integer,
  body text NOT NULL,
  kind text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'reject', 'correction')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_comments_response_idx ON public.review_comments (response_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_comments TO authenticated;
GRANT ALL ON public.review_comments TO service_role;
ALTER TABLE public.review_comments ENABLE ROW LEVEL SECURITY;

-- 7. 작성 예시 라이브러리
CREATE TABLE public.example_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  field text NOT NULL CHECK (field IN ('definition', 'mission', 'task', 'activity', 'skill')),
  good_example text NOT NULL,
  bad_example text,
  note text,
  sort integer NOT NULL DEFAULT 0
);
CREATE INDEX example_library_lookup_idx ON public.example_library (category, field, sort);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.example_library TO authenticated;
GRANT ALL ON public.example_library TO service_role;
ALTER TABLE public.example_library ENABLE ROW LEVEL SECURITY;

-- 소유·편집가능 판정 헬퍼 (SECURITY DEFINER: 자식 테이블 정책에서 responses 재귀 참조 회피)
CREATE OR REPLACE FUNCTION public.owns_response(_response_id uuid, _editable boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.responses r
    JOIN public.participants p ON p.id = r.participant_id
    WHERE r.id = _response_id
      AND p.user_id = auth.uid()
      AND (NOT _editable OR r.status IN ('draft', 'rejected'))
  );
$$;

CREATE OR REPLACE FUNCTION public.owns_task(_task_id uuid, _editable boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.owns_response((SELECT response_id FROM public.response_tasks WHERE id = _task_id), _editable);
$$;

-- RLS 정책
-- responses: 본인 participant 행에 연결된 응답만. 수정은 draft/rejected 일 때만.
-- (제출 시 status→submitted 전환을 허용해야 하므로 WITH CHECK 은 소유 여부만 본다)
CREATE POLICY "owners view own response" ON public.responses
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.participants p WHERE p.id = participant_id AND p.user_id = auth.uid()));
CREATE POLICY "owners insert own response" ON public.responses
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.participants p WHERE p.id = participant_id AND p.user_id = auth.uid()));
CREATE POLICY "owners update own draft response" ON public.responses
  FOR UPDATE TO authenticated
  USING (
    status IN ('draft', 'rejected')
    AND EXISTS (SELECT 1 FROM public.participants p WHERE p.id = participant_id AND p.user_id = auth.uid())
  )
  WITH CHECK (EXISTS (SELECT 1 FROM public.participants p WHERE p.id = participant_id AND p.user_id = auth.uid()));
CREATE POLICY "admins manage responses" ON public.responses
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 자식 테이블: 조회는 항상, 쓰기는 부모가 draft/rejected 일 때만
CREATE POLICY "owners view own tasks" ON public.response_tasks
  FOR SELECT TO authenticated USING (public.owns_response(response_id));
CREATE POLICY "owners write own tasks" ON public.response_tasks
  FOR ALL TO authenticated
  USING (public.owns_response(response_id, true))
  WITH CHECK (public.owns_response(response_id, true));
CREATE POLICY "admins manage tasks" ON public.response_tasks
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "owners view own activities" ON public.response_activities
  FOR SELECT TO authenticated USING (public.owns_task(task_id));
CREATE POLICY "owners write own activities" ON public.response_activities
  FOR ALL TO authenticated
  USING (public.owns_task(task_id, true))
  WITH CHECK (public.owns_task(task_id, true));
CREATE POLICY "admins manage activities" ON public.response_activities
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "owners view own skills" ON public.response_skills
  FOR SELECT TO authenticated USING (public.owns_response(response_id));
CREATE POLICY "owners write own skills" ON public.response_skills
  FOR ALL TO authenticated
  USING (public.owns_response(response_id, true))
  WITH CHECK (public.owns_response(response_id, true));
CREATE POLICY "admins manage skills" ON public.response_skills
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "owners view own requirements" ON public.response_requirements
  FOR SELECT TO authenticated USING (public.owns_response(response_id));
CREATE POLICY "owners write own requirements" ON public.response_requirements
  FOR ALL TO authenticated
  USING (public.owns_response(response_id, true))
  WITH CHECK (public.owns_response(response_id, true));
CREATE POLICY "admins manage requirements" ON public.response_requirements
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "owners view own review comments" ON public.review_comments
  FOR SELECT TO authenticated USING (public.owns_response(response_id));
CREATE POLICY "admins manage review comments" ON public.review_comments
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "signed in users view examples" ON public.example_library
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage examples" ON public.example_library
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 예시 라이브러리 시드 (직군 카테고리 4종 × 항목 5종)
INSERT INTO public.example_library (category, field, good_example, bad_example, note, sort) VALUES
-- 사무관리
('사무관리', 'definition',
 '회사의 인적자원을 확보·육성·평가·보상하는 제도를 설계하고 운영하여 조직의 인력 경쟁력을 유지하는 직무',
 '인사 관련 업무를 담당하는 직무',
 '직무 정의는 「무엇을 대상으로 어떤 활동을 하여 어떤 상태를 만드는가」가 한 문장에 드러나야 한다.', 1),
('사무관리', 'mission',
 '적기·적소에 필요한 인력을 배치하고 공정한 평가·보상 체계를 운영하여 임직원의 몰입도와 조직 생산성을 높인다',
 '인사 업무를 잘 수행한다',
 '미션은 직무가 회사에 기여하는 최종 성과(Output)로 표현한다.', 2),
('사무관리', 'task',
 '월간 인건비 실적을 집계·분석하여 경영회의 보고자료를 작성한다',
 '보고서 작성',
 '과업은 「행위 + 목적」이 드러나는 한 문장으로 쓴다. 명사만 나열하면 무엇을 왜 하는지 알 수 없다.', 3),
('사무관리', 'task',
 '연간 채용계획에 따라 채용공고를 게시하고 서류·면접 전형을 운영하여 필요 인력을 확보한다',
 '채용 진행',
 '「~을 ~하여 ~한다」 구조를 지키면 과업의 범위와 산출물이 함께 드러난다.', 4),
('사무관리', 'activity',
 '부서별 인력 요청서를 취합하여 직무별 채용 요건표로 정리한다',
 '요청서 취합',
 '활동은 과업을 구성하는 실행 단위로, 과업보다 구체적이고 짧은 주기로 반복된다.', 5),
('사무관리', 'skill',
 '노동관계법령 해석 능력 - 근로기준법·파견법 등을 사안에 적용하여 인사 리스크를 사전에 판단할 수 있는 지식',
 '커뮤니케이션',
 '스킬은 명칭만 쓰지 말고 「어떤 상황에서 무엇을 할 수 있는 능력인지」 설명을 덧붙인다.', 6),

-- 생산기술
('생산기술', 'definition',
 '생산라인의 설비·공정 조건을 관리하고 이상을 개선하여 목표 생산량과 품질 수준을 안정적으로 확보하는 직무',
 '생산 현장을 관리하는 직무',
 '관리 대상(설비·공정)과 확보하려는 상태(생산량·품질)를 함께 적는다.', 1),
('생산기술', 'mission',
 '설비 가동률과 공정 불량률을 관리하여 납기 준수율 99% 이상과 목표 원가를 동시에 달성한다',
 '생산성을 높인다',
 '미션에 관리 지표를 담으면 직무의 성과 기준이 명확해진다.', 2),
('생산기술', 'task',
 '일일 설비 가동 데이터를 점검하여 비가동 원인을 분류하고 개선 대책을 수립한다',
 '설비 점검',
 '과업은 「행위 + 목적」 한 문장. 점검이라는 행위만으로는 무엇을 위한 점검인지 알 수 없다.', 3),
('생산기술', 'task',
 '신규 금형 양산 이관 시 시험생산을 실시하여 공정 조건을 표준화하고 작업표준서를 개정한다',
 '금형 관리',
 '산출물(작업표준서)까지 문장에 담으면 과업의 완료 기준이 분명해진다.', 4),
('생산기술', 'activity',
 '교대조별 생산일보의 불량 수량을 집계하여 불량 유형별 파레토 차트를 갱신한다',
 '불량 집계',
 '활동 단위에서는 데이터의 출처와 결과물 형태까지 구체화한다.', 5),
('생산기술', 'skill',
 '공정능력 분석(SPC) - 관리도와 Cp/Cpk 지표를 해석하여 공정 산포의 이상 여부를 판정하는 능력',
 '엑셀 활용',
 '도구 이름이 아니라 그 도구로 내리는 판단을 적어야 스킬이 된다.', 6),

-- 영업
('영업', 'definition',
 '담당 고객사의 수주 기회를 발굴하고 견적·계약·납기 조건을 협상하여 매출과 수익성 목표를 달성하는 직무',
 '제품을 판매하는 직무',
 '영업은 판매 행위보다 「기회 발굴 → 협상 → 목표 달성」의 과정으로 정의한다.', 1),
('영업', 'mission',
 '고객사와의 장기 거래관계를 유지·확대하여 담당 계정의 연간 매출목표와 목표 마진율을 달성한다',
 '매출을 올린다',
 '단기 실적과 관계 유지라는 두 축을 함께 담는다.', 2),
('영업', 'task',
 '고객사 연간 생산계획을 입수·분석하여 품목별 수주 예측치를 산출하고 영업계획에 반영한다',
 '수주 관리',
 '「행위 + 목적」 형식. 무엇을 근거로 무엇을 만드는지가 드러나야 한다.', 3),
('영업', 'task',
 '원자재 가격 변동분을 산출하여 고객사와 단가 조정 협상을 진행하고 계약 단가에 반영한다',
 '단가 협상',
 '협상의 근거(원가 변동)와 결과(계약 반영)를 문장에 포함한다.', 4),
('영업', 'activity',
 '월별 고객사 발주량과 실제 납품량 차이를 대사하여 미납 사유서를 작성한다',
 '납품 확인',
 '활동은 실무자가 실제로 손을 움직이는 최소 단위로 기술한다.', 5),
('영업', 'skill',
 '원가 구조 이해 - 재료비·가공비 구성을 분해하여 고객 요구 단가의 수용 가능 범위를 판단하는 능력',
 '협상력',
 '「협상력」 같은 추상어 대신 협상을 가능하게 하는 구체적 판단 능력을 적는다.', 6),

-- 연구개발
('연구개발', 'definition',
 '고객 요구사양과 법규를 반영한 제품·공법을 설계·검증하여 양산 가능한 도면과 사양서로 확정하는 직무',
 '신제품을 개발하는 직무',
 '개발의 입력(요구사양·법규)과 출력(도면·사양서)을 함께 밝힌다.', 1),
('연구개발', 'mission',
 '개발 일정과 목표 원가를 준수하는 설계안을 확정하여 양산 이관 후 설계기인 불량 발생을 최소화한다',
 '좋은 제품을 만든다',
 '설계 품질의 최종 판정 시점(양산 이후)까지 미션에 포함한다.', 2),
('연구개발', 'task',
 '고객 요구사양서를 검토하여 설계 요구조건을 정의하고 개발 사양서로 문서화한다',
 '사양 검토',
 '「행위 + 목적」 한 문장 원칙. 검토 결과가 어떤 문서로 남는지 적는다.', 3),
('연구개발', 'task',
 '시작품에 대한 내구·환경 시험을 의뢰·평가하여 설계 변경점을 도출하고 도면에 반영한다',
 '시험 평가',
 '평가에서 끝나지 않고 반영까지 이어지는 범위를 문장에 담는다.', 4),
('연구개발', 'activity',
 '3D 모델의 간섭 여부를 검토하여 설계 변경 요청서(ECR)를 발행한다',
 'CAD 작업',
 '사용하는 도구가 아니라 그 도구로 만들어내는 결과를 적는다.', 5),
('연구개발', 'skill',
 '구조해석(CAE) 결과 해석 - 응력·변형 해석 결과를 설계 기준과 대조하여 형상 변경 방향을 결정하는 능력',
 'CATIA 사용 가능',
 '툴 사용 여부가 아니라 결과를 해석해 의사결정하는 수준으로 기술한다.', 6);
