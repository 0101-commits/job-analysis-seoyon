-- 역할단계 명칭 세트 (전사 공통)
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS role_levels text[] NOT NULL DEFAULT '{담당,선임,책임,리더}';
