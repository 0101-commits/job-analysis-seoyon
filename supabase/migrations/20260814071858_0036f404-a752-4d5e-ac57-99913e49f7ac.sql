CREATE TYPE public.app_role AS ENUM ('respondent','admin');
CREATE TYPE public.account_status AS ENUM ('미발송','초대발송','미접속','작성중','제출','반려','승인');

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE TABLE public.participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  emp_no text NOT NULL,
  name text NOT NULL,
  email text,
  birth_date date,
  org_text text,
  grade text,
  role_level text,
  role public.app_role NOT NULL DEFAULT 'respondent',
  account_status public.account_status NOT NULL DEFAULT '미발송',
  invited_at timestamptz,
  first_login_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, emp_no)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.participants TO authenticated;
GRANT ALL ON public.participants TO service_role;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signed in users can view companies" ON public.companies
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage companies" ON public.companies
  FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "users view own roles" ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));

CREATE POLICY "respondents view own participant row" ON public.participants
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "respondents update own participant row" ON public.participants
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "admins insert participants" ON public.participants
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY "admins update participants" ON public.participants
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY "admins delete participants" ON public.participants
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER participants_updated_at BEFORE UPDATE ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.companies (name, code) VALUES ('서연','SY'),('서연이화','SYEH'),('서연탑메탈','SYTM');

INSERT INTO public.participants (company_id, emp_no, name, email, birth_date, org_text, grade, role_level, role, account_status)
SELECT c.id, v.emp_no, v.name, v.email, v.birth_date::date, v.org_text, v.grade, v.role_level, v.role::public.app_role, v.account_status::public.account_status
FROM (VALUES
 ('SY','20180112','김지훈','jihoon.kim@seoyon.example','1985-03-12','경영기획본부 / 기획팀','부장','팀장','respondent','승인'),
 ('SY','20190233','박서연','seoyeon.park@seoyon.example','1990-07-05','경영기획본부 / 재무팀','과장','팀원','respondent','제출'),
 ('SY','20200451','이도현','dohyun.lee@seoyon.example','1992-11-21','생산본부 / 품질관리팀','대리','팀원','respondent','작성중'),
 ('SY','20210077','최민아','mina.choi@seoyon.example','1994-01-30','경영지원본부 / 인사팀','사원','팀원','respondent','초대발송'),
 ('SY','20150908','정우성','wooseong.jung@seoyon.example','1982-05-17','연구개발본부 / 선행연구팀','차장','팀장','respondent','미접속'),
 ('SYEH','30170345','한소희','sohee.han@seoyoneh.example','1988-09-09','영업본부 / 국내영업팀','부장','팀장','respondent','승인'),
 ('SYEH','30180912','오세훈','sehoon.oh@seoyoneh.example','1991-02-14','생산본부 / 사출생산팀','과장','팀원','respondent','반려'),
 ('SYEH','30200188','윤하늘','haneul.yoon@seoyoneh.example','1993-06-23','생산본부 / 설비팀','대리','팀원','respondent','작성중'),
 ('SYEH','30210562','서지안','jian.seo@seoyoneh.example','1995-12-02','경영지원본부 / 총무팀','사원','팀원','respondent','미발송'),
 ('SYEH','30160431','강태오','taeoh.kang@seoyoneh.example','1986-08-08','연구개발본부 / 설계팀','차장','팀장','respondent','제출'),
 ('SY','90000001','HCG 컨설턴트','consultant@hcg.example','1980-04-04','HCG 컨설팅','컨설턴트','관리자','admin','승인')
) AS v(code, emp_no, name, email, birth_date, org_text, grade, role_level, role, account_status)
JOIN public.companies c ON c.code = v.code;
