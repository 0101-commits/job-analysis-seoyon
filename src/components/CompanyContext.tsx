import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type CompanyContextValue = {
  companyId: string;
  setCompanyId: (id: string) => void;
};

const CompanyCtx = createContext<CompanyContextValue>({
  companyId: "all",
  setCompanyId: () => {},
});

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [companyId, setCompanyId] = useState("all");
  const value = useMemo(() => ({ companyId, setCompanyId }), [companyId]);
  return <CompanyCtx.Provider value={value}>{children}</CompanyCtx.Provider>;
}

export function useCompanyScope() {
  return useContext(CompanyCtx);
}
