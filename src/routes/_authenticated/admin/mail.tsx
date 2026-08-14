import { createFileRoute } from "@tanstack/react-router";
import { AdminPagePlaceholder } from "@/components/AdminShell";

export const Route = createFileRoute("/_authenticated/admin/mail")({
  head: () => ({
    meta: [
      { title: "메일 발송 | 서연 그룹 업무조사" },
      { name: "description", content: "초대 및 안내 메일 발송 이력을 관리합니다." },
      { property: "og:title", content: "메일 발송 | 서연 그룹 업무조사" },
      { property: "og:description", content: "초대 및 안내 메일 발송 이력을 관리합니다." },
    ],
  }),
  component: () => (
    <AdminPagePlaceholder title="메일 발송" description="초대 및 안내 메일 발송 이력을 관리합니다." />
  ),
});
