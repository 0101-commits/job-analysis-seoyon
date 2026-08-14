-- 1. participants 확장
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS initial_password text,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- 2. 시스템 설정 (초기 PW 규칙)
CREATE TABLE public.system_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  password_rule text NOT NULL DEFAULT '{birth6}{empno_last4}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.system_settings TO authenticated;
GRANT ALL ON public.system_settings TO service_role;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage system settings" ON public.system_settings
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER system_settings_updated_at BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
INSERT INTO public.system_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- 3. 계열사별 조사 운영 설정
CREATE TABLE public.survey_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  deadline date,
  reminder_days integer[] NOT NULL DEFAULT '{7,3,1}',
  reminder_target text NOT NULL DEFAULT '미제출' CHECK (reminder_target IN ('미접속', '미제출')),
  reminder_auto boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.survey_settings TO authenticated;
GRANT ALL ON public.survey_settings TO service_role;
ALTER TABLE public.survey_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signed in users view survey settings" ON public.survey_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage survey settings" ON public.survey_settings
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER survey_settings_updated_at BEFORE UPDATE ON public.survey_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
INSERT INTO public.survey_settings (company_id) SELECT id FROM public.companies ON CONFLICT DO NOTHING;

-- 4. 메일 템플릿
CREATE TABLE public.mail_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('invite', 'reminder', 'custom')),
  subject text NOT NULL,
  body text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mail_templates TO authenticated;
GRANT ALL ON public.mail_templates TO service_role;
ALTER TABLE public.mail_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage mail templates" ON public.mail_templates
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER mail_templates_updated_at BEFORE UPDATE ON public.mail_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.mail_templates (name, kind, subject, body, is_default) VALUES
('기본 초대 메일', 'invite', '[서연 그룹 업무조사] {이름}님, 조사 참여 안내드립니다',
'{이름}님 안녕하세요.

{회사} {소속} 소속 임직원 대상 업무조사가 시작되었습니다.
아래 계정 정보로 접속하여 {마감일}까지 작성을 완료해 주시기 바랍니다.

- 접속 주소: {접속링크}
- 아이디: {ID}
- 초기 비밀번호: {초기PW}

최초 로그인 시 비밀번호를 변경하셔야 합니다.
문의사항은 HCG 컨설팅 담당자에게 연락 주십시오.

감사합니다.', true),
('기본 리마인더 메일', 'reminder', '[서연 그룹 업무조사] {이름}님, 제출 기한이 얼마 남지 않았습니다',
'{이름}님 안녕하세요.

{회사} 업무조사 제출 마감일은 {마감일}입니다.
아직 작성이 완료되지 않아 안내드립니다.

- 접속 주소: {접속링크}
- 아이디: {ID}

기한 내 작성을 부탁드립니다.

감사합니다.', true);

-- 5. 메일 배치
CREATE TABLE public.mail_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  template_id uuid REFERENCES public.mail_templates(id) ON DELETE SET NULL,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT '대기' CHECK (status IN ('대기', '예약', '발송중', '완료', '실패')),
  total_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  simulated boolean NOT NULL DEFAULT false,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mail_batches TO authenticated;
GRANT ALL ON public.mail_batches TO service_role;
ALTER TABLE public.mail_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage mail batches" ON public.mail_batches
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER mail_batches_updated_at BEFORE UPDATE ON public.mail_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. 메일 발송 로그
CREATE TABLE public.mail_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES public.mail_batches(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES public.participants(id) ON DELETE SET NULL,
  template_id uuid REFERENCES public.mail_templates(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  to_name text,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('성공', '실패', '시뮬레이션')),
  error_message text,
  provider_id text,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_logs_batch_idx ON public.mail_logs (batch_id);
CREATE INDEX mail_logs_participant_idx ON public.mail_logs (participant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mail_logs TO authenticated;
GRANT ALL ON public.mail_logs TO service_role;
ALTER TABLE public.mail_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage mail logs" ON public.mail_logs
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 7. 감사 로그
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON public.audit_logs (created_at DESC);
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins view audit logs" ON public.audit_logs
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
