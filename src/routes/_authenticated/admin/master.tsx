import { createFileRoute } from "@tanstack/react-router";
import { AdminPagePlaceholder } from "@/components/AdminShell";

export const Route = createFileRoute("/_authenticated/admin/master")({
  head: () => ({
    meta: [
      { title: "마스터 관리 | 서연 그룹 업무조사" },
      { name: "description", content: "직무·조직·등급 등 기준 정보를 관리합니다." },
      { property: "og:title", content: "마스터 관리 | 서연 그룹 업무조사" },
      { property: "og:description", content: "직무·조직·등급 등 기준 정보를 관리합니다." },
    ],
  }),
  component: () => (
    <AdminPagePlaceholder title="마스터 관리" description="직무·조직·등급 등 기준 정보를 관리합니다." />
  ),
});
