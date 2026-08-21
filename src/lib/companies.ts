// 계열사 목록 조회의 단일 창구.
// companies.status 컬럼은 스키마에 처음부터 있었지만 아무도 읽지 않았다.
// v4부터 계열사를 설정에서 켜고 끌 수 있으므로, 화면·발송·집계는
// 반드시 이 함수를 거쳐 '운영 중' 계열사만 보게 한다.
// (중지된 계열사의 데이터는 지워지지 않고 화면에서만 빠진다.)
import { supabase } from "@/integrations/supabase/client";

export type CompanyRow = { id: string; name: string; code: string };

/** 운영 중(status='active') 계열사만 이름순으로 */
export async function listActiveCompanies(): Promise<CompanyRow[]> {
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, code")
    .eq("status", "active")
    .order("name");
  if (error) throw error;
  return (data ?? []) as CompanyRow[];
}

/** 중지 포함 전체 — 설정 › 계열사 운영 화면 전용 */
export async function listAllCompanies(): Promise<(CompanyRow & { status: string })[]> {
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, code, status")
    .order("name");
  if (error) throw error;
  return (data ?? []) as (CompanyRow & { status: string })[];
}
