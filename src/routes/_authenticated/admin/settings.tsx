import { createFileRoute } from "@tanstack/react-router";
import { AdminPagePlaceholder } from "@/components/AdminShell";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  head: () => ({
    meta: [
      { title: "설정 | 서연 그룹 업무조사" },
      { name: "description", content: "조사 기간, 권한 등 시스템 설정을 관리합니다." },
      { property: "og:title", content: "설정 | 서연 그룹 업무조사" },
      { property: "og:description", content: "조사 기간, 권한 등 시스템 설정을 관리합니다." },
    ],
  }),
  component: () => (
    <AdminPagePlaceholder title="설정" description="조사 기간, 권한 등 시스템 설정을 관리합니다." />
  ),
});
