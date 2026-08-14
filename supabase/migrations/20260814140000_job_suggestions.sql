-- 직무 표기 자동완성: 같은 계열사 응답들의 직군/직렬/직무 distinct 값 공유
-- 개인정보 없이 표기 문자열만 반환하므로 SECURITY DEFINER 로 RLS 우회 허용
CREATE OR REPLACE FUNCTION public.job_suggestions(_company_id uuid)
RETURNS TABLE (job_group text, job_series text, job_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT r.job_group, r.job_series, r.job_name
  FROM public.responses r
  WHERE r.company_id = _company_id
    AND EXISTS (
      SELECT 1 FROM public.participants p
      WHERE p.user_id = auth.uid() AND p.company_id = _company_id
    );
$$;
REVOKE EXECUTE ON FUNCTION public.job_suggestions(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.job_suggestions(uuid) TO authenticated;
