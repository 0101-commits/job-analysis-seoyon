import { useNavigate, useRouterState } from "@tanstack/react-router";
import { applyLensPatch, pickLens } from "@/lib/lens-search";

const DEFAULT_COMPANY = "all";

/**
 * 계열사 렌즈 — URL 의 `?co=` 가 유일한 원천이다 (기획 v2 P2).
 *
 * 이전에는 useState 로만 들고 있어 새로고침하면 "전체 계열사"로 되돌아갔고, 같은 링크가
 * 사람마다 다른 계열사를 보여줬다. 두 번째 원천(state)을 없애고 주소 하나로만 결정한다.
 */
export function useCompanyScope() {
  const search = useRouterState({ select: (s) => s.location.search });
  const navigate = useNavigate();
  const companyId = pickLens(search as Record<string, unknown>).co ?? DEFAULT_COMPANY;

  function setCompanyId(id: string) {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) =>
        applyLensPatch(prev, { co: id === DEFAULT_COMPANY ? null : id }),
    });
  }

  return { companyId, setCompanyId };
}
