-- 보안 강화: 권한상승·자가승인·AI제안 위조·계열사 위조 차단 + account_status 자동전이
-- 기존 마이그레이션은 수정하지 않고 이 파일에서 DROP/CREATE 로 교정한다.

-- ---------------------------------------------------------------------------
-- C-1. participants 권한상승 차단
--   기존: "respondents update own participant row" 정책이 본인 행 전체를 열어두어
--         role / account_status / company_id / emp_no / must_change_password /
--         failed_login_count / locked_until 까지 응답자가 스스로 바꿀 수 있었다.
--   조치: 응답자 UPDATE 정책 삭제 + authenticated 의 UPDATE 권한 회수.
--         participants 쓰기는 전부 service_role(서버 함수) 또는 SECURITY DEFINER 함수로만.
--   확인: src/lib/{admin,auth,review}.functions.ts 의 participants 갱신은 모두
--         supabaseAdmin(service_role) 경유이므로 회수해도 회귀 없음.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "respondents update own participant row" ON public.participants;
REVOKE UPDATE ON public.participants FROM authenticated;

-- 응답자가 자기 행에서 갱신할 수 있는 유일한 필드: 접속 시각
CREATE OR REPLACE FUNCTION public.touch_my_last_seen()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.participants
     SET last_seen_at = now(),
         first_login_at = COALESCE(first_login_at, now())
   WHERE user_id = auth.uid();
$$;
REVOKE EXECUTE ON FUNCTION public.touch_my_last_seen() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.touch_my_last_seen() TO authenticated;

-- ---------------------------------------------------------------------------
-- H-3. 자가승인 차단 (responses)
--   기존: WITH CHECK 이 소유 여부만 봐서 응답자가 status='approved',
--         reviewed_by=임의값 으로 스스로 승인 처리할 수 있었다.
--   조치 1) WITH CHECK 에 status 허용집합 추가 — 'approved' 만 제외한다.
--          ('rejected' 를 빼면 반려 후 재작성 저장이 막힌다: saveResponseFields 는
--           status 를 patch 하지 않아 NEW.status 가 'rejected' 그대로 남는다.)
--   조치 2) RLS 는 OLD 값을 볼 수 없으므로 검토 흔적·소속 고정은 BEFORE 트리거로.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "owners update own draft response" ON public.responses;
CREATE POLICY "owners update own draft response" ON public.responses
  FOR UPDATE TO authenticated
  USING (
    status IN ('draft', 'rejected')
    AND EXISTS (SELECT 1 FROM public.participants p WHERE p.id = participant_id AND p.user_id = auth.uid())
  )
  WITH CHECK (
    status IN ('draft', 'submitted', 'rejected')
    AND EXISTS (
      SELECT 1 FROM public.participants p
      WHERE p.id = responses.participant_id
        AND p.user_id = auth.uid()
        AND p.company_id = responses.company_id
    )
  );

-- 응답자(로그인 사용자 중 비관리자)는 검토 흔적·소유·소속을 바꿀 수 없다.
-- service_role(auth.uid() IS NULL) 과 관리자는 그대로 통과시킨다.
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

-- ---------------------------------------------------------------------------
-- M-3. 계열사 위조 차단 (responses INSERT)
--   기존: company_id 를 본인 소속과 무관하게 지정할 수 있었다.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "owners insert own response" ON public.responses;
CREATE POLICY "owners insert own response" ON public.responses
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.participants p
      WHERE p.id = responses.participant_id
        AND p.user_id = auth.uid()
        AND p.company_id = responses.company_id
    )
  );

-- ---------------------------------------------------------------------------
-- H-4. AI 제안 위조 차단 (ai_suggestions)
--   기존: "owners decide requested suggestions" 의 WITH CHECK 가 소유 여부만 봐서
--         응답자가 target / suggested_value / route / kind / response_id 를 갈아끼우고
--         status='확정' 까지 찍을 수 있었다. RLS 는 컬럼 단위 비교가 불가하므로
--         정책을 삭제하고 SECURITY DEFINER 함수로만 결정하게 한다.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "owners decide requested suggestions" ON public.ai_suggestions;

-- '수정' 결정 시 AI 원문 보존용. suggested_value 에는 실제 반영될 값(응답자 수정본)이 남아
-- 관리자 applySuggestion(src/lib/ai.functions.ts)이 변경 없이 동작한다.
ALTER TABLE public.ai_suggestions ADD COLUMN IF NOT EXISTS ai_suggested_value text;

CREATE OR REPLACE FUNCTION public.decide_suggestion(
  _id uuid,
  _decision text,
  _note text DEFAULT NULL,
  _edited text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_response_id uuid;
BEGIN
  IF _decision NOT IN ('수락', '수정', '거절') THEN
    RAISE EXCEPTION '허용되지 않은 결정입니다: %', _decision;
  END IF;
  IF _decision = '수정' AND COALESCE(btrim(_edited), '') = '' THEN
    RAISE EXCEPTION '수정 결정에는 수정한 내용이 필요합니다.';
  END IF;

  SELECT response_id INTO v_response_id
    FROM public.ai_suggestions WHERE id = _id AND status = '요청중';
  IF v_response_id IS NULL OR NOT public.owns_response(v_response_id) THEN
    RAISE EXCEPTION '결정할 수 없는 제안입니다.';
  END IF;

  UPDATE public.ai_suggestions
     SET status = _decision,
         respondent_note = _note,
         decided_by = auth.uid(),
         decided_at = now(),
         ai_suggested_value = CASE WHEN _decision = '수정'
                                   THEN COALESCE(ai_suggested_value, suggested_value)
                                   ELSE ai_suggested_value END,
         suggested_value = CASE WHEN _decision = '수정' THEN btrim(_edited) ELSE suggested_value END
   WHERE id = _id;
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.decide_suggestion(uuid, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.decide_suggestion(uuid, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- account_status 자동전이
--   기존: responses.status 와 participants.account_status 가 각각 갱신되어
--         독촉 대상·집계가 어긋났다(감사 C3/H2). responses 를 단일 원천으로 삼는다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_account_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status public.account_status;
BEGIN
  v_status := CASE NEW.status
                WHEN 'draft' THEN '작성중'
                WHEN 'submitted' THEN '제출'
                WHEN 'rejected' THEN '반려'
                WHEN 'approved' THEN '승인'
              END::public.account_status;
  IF v_status IS NULL THEN RETURN NEW; END IF;

  UPDATE public.participants
     SET account_status = v_status
   WHERE id = NEW.participant_id
     AND account_status IS DISTINCT FROM v_status;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sync_account_status() FROM anon, authenticated, public;
DROP TRIGGER IF EXISTS responses_sync_account_status ON public.responses;
CREATE TRIGGER responses_sync_account_status
  AFTER INSERT OR UPDATE OF status ON public.responses
  FOR EACH ROW EXECUTE FUNCTION public.sync_account_status();

-- 기존 데이터 정합화
UPDATE public.participants p
   SET account_status = CASE r.status
                          WHEN 'draft' THEN '작성중'
                          WHEN 'submitted' THEN '제출'
                          WHEN 'rejected' THEN '반려'
                          WHEN 'approved' THEN '승인'
                        END::public.account_status
  FROM public.responses r
 WHERE r.participant_id = p.id
   AND p.account_status IS DISTINCT FROM CASE r.status
                          WHEN 'draft' THEN '작성중'
                          WHEN 'submitted' THEN '제출'
                          WHEN 'rejected' THEN '반려'
                          WHEN 'approved' THEN '승인'
                        END::public.account_status;

-- ---------------------------------------------------------------------------
-- M. 내부 정정이력(kind='correction') 은 응답자에게 노출하지 않는다.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "owners view own review comments" ON public.review_comments;
CREATE POLICY "owners view own review comments" ON public.review_comments
  FOR SELECT TO authenticated
  USING (public.owns_response(response_id) AND kind IN ('comment', 'reject'));

-- has_role(uuid, app_role) 의 authenticated EXECUTE 는 RLS 정책 본문에서 호출되므로
-- 회수하면 전 테이블 관리자 정책이 깨진다. 유지한다.
