-- v6: 직군·직렬·직무의 화면 표시 순서 (관리자 직무분류표 정렬용)
ALTER TABLE public.job_catalog ADD COLUMN IF NOT EXISTS group_sort integer NOT NULL DEFAULT 0;
ALTER TABLE public.job_catalog ADD COLUMN IF NOT EXISTS series_sort integer NOT NULL DEFAULT 0;
ALTER TABLE public.job_catalog ADD COLUMN IF NOT EXISTS sort integer NOT NULL DEFAULT 0;
