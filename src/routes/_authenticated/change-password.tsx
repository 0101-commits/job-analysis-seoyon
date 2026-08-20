import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { fetchMyRole } from "@/lib/auth";
import { changeMyPassword } from "@/lib/auth.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/change-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "비밀번호 변경 | 서연 그룹 업무조사" },
      { name: "description", content: "최초 로그인 시 비밀번호를 변경합니다." },
      { property: "og:title", content: "비밀번호 변경 | 서연 그룹 업무조사" },
      { property: "og:description", content: "최초 로그인 시 비밀번호를 변경합니다." },
    ],
  }),
  component: ChangePasswordPage,
});

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

function ChangePasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!PASSWORD_RULE.test(password)) {
      toast.error("비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.");
      return;
    }
    if (password !== confirm) {
      toast.error("두 비밀번호가 일치하지 않습니다.");
      return;
    }

    setLoading(true);
    try {
      // 서버가 적용까지 수행한다 — 적용값과 명부 기록이 갈라지지 않게.
      await changeMyPassword({ data: { password } });
      const role = await fetchMyRole();
      toast.success("비밀번호가 변경되었습니다.");
      navigate({ to: role === "admin" ? "/admin" : "/home", replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      toast.error(`비밀번호 변경에 실패했습니다: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-secondary px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="text-sm font-medium tracking-wide text-primary">HCG 컨설팅</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">비밀번호 변경</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            보안을 위해 최초 로그인 시 비밀번호를 변경해 주세요.
          </p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="new-password">새 비밀번호</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="영문+숫자 포함 8자 이상"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">새 비밀번호 확인</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="한 번 더 입력"
              />
            </div>
            <Button type="submit" className="h-11 w-full text-base" disabled={loading}>
              {loading ? "변경 중..." : "비밀번호 변경"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          본 시스템의 모든 자료는 대외비이며, 무단 열람 및 배포를 금합니다.
        </p>
      </div>
    </main>
  );
}
