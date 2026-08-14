import { createFileRoute } from "@tanstack/react-router";
import { AdminPagePlaceholder } from "@/components/AdminShell";

export const Route = createFileRoute("/_authenticated/admin/review")({
  head: () => ({
    meta: [
      { title: "검토 큐 | 서연 그룹 업무조사" },
      { name: "description", content: "제출된 업무조사를 검토하고 승인 또는 반려합니다." },
      { property: "og:title", content: "검토 큐 | 서연 그룹 업무조사" },
      { property: "og:description", content: "제출된 업무조사를 검토하고 승인 또는 반려합니다." },
    ],
  }),
  component: () => (
    <AdminPagePlaceholder title="검토 큐" description="제출된 업무조사를 검토하고 승인 또는 반려합니다." />
  ),
});
