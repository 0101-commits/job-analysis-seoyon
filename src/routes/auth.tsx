import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchMyRole } from "@/lib/auth";
import { signInWithLock } from "@/lib/auth.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "로그인 | 서연 그룹 업무조사" },
      { name: "description", content: "서연 그룹 업무조사 시스템 로그인 페이지입니다." },
      { property: "og:title", content: "로그인 | 서연 그룹 업무조사" },
      { property: "og:description", content: "서연 그룹 업무조사 시스템 로그인 페이지입니다." },
    ],
  }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/" });
  },
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const LOCK_MESSAGE = "계정이 잠겼습니다. 30분 후 다시 시도하거나 관리자에게 문의하세요.";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // 인증·잠금 판정은 전부 서버에서. 클라이언트는 결과 세션만 받는다.
      const result = await signInWithLock({ data: { email, password } });
      if (result.status === "locked") {
        toast.error(LOCK_MESSAGE);
        return;
      }
      if (result.status !== "ok") {
        toast.error("로그인에 실패했습니다. 아이디와 비밀번호를 확인해 주세요.");
        return;
      }

      const { error } = await supabase.auth.setSession(result.session);
      if (error) throw error;

      const role = await fetchMyRole();
      toast.success("로그인되었습니다.");
      navigate({ to: role === "admin" ? "/admin" : "/home", replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      toast.error(`로그인에 실패했습니다: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-secondary px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="text-sm font-medium tracking-wide text-primary">HCG 컨설팅</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">서연 그룹 업무조사</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            사내 계정으로 로그인 후 조사에 참여해 주세요.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
          <h2 className="text-lg font-semibold">로그인</h2>
          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">아이디 (이메일)</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8자 이상 입력"
              />
            </div>
            <Button type="submit" className="h-11 w-full text-base" disabled={loading}>
              {loading ? "처리 중..." : "로그인"}
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-muted-foreground">
            계정은 관리자가 발급합니다. 계정 문의는 관리자에게 연락해 주세요.
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          본 시스템의 모든 자료는 대외비이며, 무단 열람 및 배포를 금합니다.
        </p>
      </div>
    </main>
  );
}
