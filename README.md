# 서연 그룹 직무분석 업무조사 플랫폼

HCG 컨설팅용 직무분석 업무조사 웹 플랫폼. 복수 계열사(서연·서연이화·서연탑메탈)의 임직원이 직접 자기 직무의 과업·스킬·요건을 작성하고, 컨설턴트(admin)가 검토·승인하여 표준 직무기술서(stdjob) 원천 데이터를 산출한다.

## 스택
- TanStack Start (React 19 · SSR) · Tailwind CSS 4 · shadcn/ui
- Supabase (PostgreSQL · Auth · RLS)
- AI 어시스트: elizax-proxy (Cloudflare Worker, Claude API)
- 배포: Nitro → Cloudflare Workers 프리셋 내장

## 구현 범위 (P0~P5)
- **P0** 로그인 게이트 · 역할 라우팅(응답자/관리자) · RLS · robots/noindex · 멀티 계열사 골격
- **P1** 명부 업로드 · 계정 일괄 생성 · PW 규칙 빌더 · 메일 템플릿/배치/이력(Resend, 미설정 시 시뮬레이션) · 마감/리마인더 · 로그인 잠금 · 첫 로그인 PW 변경 강제 · D-day
- **P2** 온보딩 튜토리얼(강제) · 6단계 조사 마법사(자동저장 · 검증 게이트 · 직군별 예시)
- **P3** 검토 큐 · 승인/반려 · 동일 직무 비교 뷰
- **P4** AI 도구(오타 검수 · 부실 감지 · 자동 채움 · 표기 병합, admin 전용) · 제안 경로 A/B · stdjob CSV·JSON 내보내기 · 수동 스냅샷
- **P5** 마스터 업로드(명부/조직도/직무분류/업무분장) 컬럼 매핑 · 기존 응답 매핑 제안

## 로컬 실행
```bash
npm install
cp .env.example .env   # 값 채우기 (아래 참조)
npm run dev            # http://localhost:8080
```
관리자 시드 계정: `consultant@hcg.example` / `Seoyon!2026hcg`

## 환경변수 (.env)
| 변수 | 용도 | 확보 |
|---|---|---|
| `VITE_SUPABASE_URL` / `SUPABASE_URL` | Supabase 프로젝트 URL | 확정: `https://asgyekuqpsbpjzqevquw.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEY` | 브라우저용 공개 키(RLS 보호) | Lovable 편집기 → Code 뷰 → `.env`, 또는 Supabase 대시보드 → Settings → API Keys |
| `SUPABASE_SERVICE_ROLE_KEY` | **서버 전용** admin API(계정 생성·RLS 우회) | Supabase 대시보드 → Settings → API Keys의 **Secret keys** (또는 JWT Keys의 service_role). **절대 커밋·클라이언트 노출 금지** |
| `RESEND_API_KEY` | 메일 실발송 | 비우면 시뮬레이션 모드(로그만) |
| `RESEND_FROM` / `APP_URL` | 발신 주소 / 앱 URL | 실발송 시 SPF·DKIM·DMARC 인증 도메인 |

- publishable 키만 있으면 **응답자 조사 플로우 전체가 로컬에서 동작**한다.
- **service_role 키가 있어야 관리자 서버 기능**(명부→계정 일괄 생성, PW 초기화, 메일 발송, AI 도구 등)이 동작한다. Lovable Cloud 배포 환경에서는 런타임이 자동 주입하므로 별도 설정이 불필요하다.

## 배포 (Cloudflare Workers)
```bash
npm run build
npx wrangler deploy    # .output/ 프리셋 사용
```
- Worker 환경변수/시크릿에 위 `.env` 값을 등록(특히 `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`).
- 자동 백업(일 2회)은 CF Cron Trigger로 스냅샷 Edge 함수를 스케줄링해 활성화.

## 데이터베이스
- 마이그레이션: `supabase/migrations/` (전부 적용 완료). 신규 환경 구성 시 순서대로 실행.
- 보안: 전 라우트 인증 필수 · RLS 전면(응답자=본인 것만, admin=전체) · anon 접근 테이블 0 · 감사 로그(admin 행위·AI 반영·내보내기).

## 산출물
관리자 → 내보내기: stdjob 4시트(job_description / task_activity / skill / skill_pool) CSV + AI-readable JSON(`schema_version` 포함).
