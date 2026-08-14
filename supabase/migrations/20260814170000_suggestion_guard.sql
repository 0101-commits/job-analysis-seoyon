-- decide_suggestion '수정' 우회 차단
--   기존: owns_response(v_response_id) 를 _editable 기본값(false)으로 호출해
--         응답 status 를 보지 않았다. 응답자가 이미 제출·승인되어 동결된 응답에도
--         '수정' 결정으로 suggested_value 를 갈아끼울 수 있었고, 관리자가
--         applySuggestion(src/lib/ai.functions.ts) 을 실행하면 본문까지 바뀌었다.
--   조치: 실제 값 편집이 일어나는 '수정' 결정에만 편집 가능 상태(draft/rejected)를 요구한다.
--         '수락'/'거절' 은 값을 건드리지 않는 단순 결정이라 제출 상태에서도 허용한다.
--   나머지 로직(결정값 검증·컬럼 한정·SECURITY DEFINER·시그니처)은 원본 그대로.
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
  -- '수정' 일 때만 _editable = true → responses.status IN ('draft','rejected') 를 함께 요구
  IF v_response_id IS NULL OR NOT public.owns_response(v_response_id, _decision = '수정') THEN
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
