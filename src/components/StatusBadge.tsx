import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  미발송: "bg-muted text-muted-foreground",
  초대발송: "bg-primary-soft text-accent-foreground",
  미접속: "bg-muted text-muted-foreground",
  작성중: "bg-warning/15 text-warning",
  제출: "bg-primary-soft text-accent-foreground",
  반려: "bg-destructive/10 text-destructive",
  승인: "bg-success/15 text-success",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold",
        STYLES[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {status}
    </span>
  );
}
