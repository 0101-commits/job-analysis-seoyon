-- v4 정비: 데모 시드 데이터 정리 (운영 개시 전 1회 실행)
-- 대상 = 2026-08-14 초기 마이그레이션이 넣은 상태 데모용 참여자 10명 + 컨설턴트 시드 행.
--   이메일 도메인이 전부 .example(발송 불가 예약 도메인)이라 실제 참여자와 겹칠 수 없다.
-- 유지 = 파일럿 계정 user@seoyon.com (리허설용, 사용자 확정).
-- responses 등 자식 행은 ON DELETE CASCADE, mail_logs·interviews 는 SET NULL 로 따라온다.

-- 1) 시드 응답자 10명 (윤하늘·오세훈의 사출생산 테스트 응답 포함 연쇄 삭제)
DELETE FROM public.participants
WHERE email LIKE '%@seoyon.example'
   OR email LIKE '%@seoyoneh.example';

-- 2) 컨설턴트 시드 행 (실제 관리자 계정 admin@admin.com 과 무관, 계정 미연결일 때만)
DELETE FROM public.participants
WHERE email = 'consultant@hcg.example'
  AND user_id IS NULL;

-- 확인
SELECT count(*) AS remaining_example_rows
FROM public.participants
WHERE email LIKE '%.example';

-- 참고: 시드 계정 중 auth.users 에 실계정이 만들어졌던 2건(haneul.yoon@·sehoon.oh@)은
-- 명부 행이 사라지면 로그인 경로가 막힌다. auth 계정 자체 삭제는 Supabase 대시보드
-- Authentication 화면에서 수동으로 (선택 사항, 방치해도 무해).
