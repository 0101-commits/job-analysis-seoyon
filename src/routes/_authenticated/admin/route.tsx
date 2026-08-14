import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminShell } from "@/components/AdminShell";
import { CompanyProvider } from "@/components/CompanyContext";
import { fetchMyRole } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/admin")({
  ssr: false,
  beforeLoad: async () => {
    const role = await fetchMyRole();
    if (role !== "admin") throw redirect({ to: "/home" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <CompanyProvider>
      <AdminShell>
        <Outlet />
      </AdminShell>
    </CompanyProvider>
  );
}
