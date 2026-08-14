import { createFileRoute } from "@tanstack/react-router";
import { AdminPagePlaceholder } from "@/components/AdminShell";

export const Route = createFileRoute("/_authenticated/admin/ai")({
  head: () => ({
    meta: [
      { title: "AI 도구 | 서연 그룹 업무조사" },
      { name: "description", content: "업무기술서 자동 정리 등 AI 보조 기능을 제공합니다." },
      { property: "og:title", content: "AI 도구 | 서연 그룹 업무조사" },
      { property: "og:description", content: "업무기술서 자동 정리 등 AI 보조 기능을 제공합니다." },
    ],
  }),
  component: () => (
    <AdminPagePlaceholder title="AI 도구" description="업무기술서 자동 정리 등 AI 보조 기능을 제공합니다." />
  ),
});
