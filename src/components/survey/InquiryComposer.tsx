// 문의 작성 다이얼로그 (F6). 홈의 [문의하기] 버튼과 마법사 안의 맥락별 문의 링크가
// 이 하나를 공유한다 — 유형만 다르게 미리 채워서 연다.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createInquiry,
  INQUIRY_CATEGORIES,
  INQUIRY_CATEGORY_LABELS,
  INQUIRY_SLA_NOTICE,
  type InquiryCategory,
} from "@/lib/inquiry.functions";
import { MY_INQUIRIES_QUERY_KEY } from "@/components/survey/InquiryAnswerBanner";

export function InquiryComposer({
  open,
  onOpenChange,
  defaultCategory = "기타",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCategory?: InquiryCategory;
}) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<InquiryCategory>(defaultCategory);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  // 다이얼로그를 열 때마다(맥락이 바뀔 수 있으므로) 유형·본문을 새로 채운다.
  useEffect(() => {
    if (open) {
      setCategory(defaultCategory);
      setBody("");
    }
  }, [open, defaultCategory]);

  async function send() {
    const trimmed = body.trim();
    if (trimmed.length < 10) {
      toast.error("문의 내용을 10자 이상 적어 주세요.");
      return;
    }
    if (trimmed.length > 2000) {
      toast.error("문의 내용은 2000자를 넘을 수 없습니다.");
      return;
    }
    setSending(true);
    try {
      await createInquiry({ data: { category, body: trimmed } });
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: MY_INQUIRIES_QUERY_KEY });
      toast.success(`문의를 접수했습니다. ${INQUIRY_SLA_NOTICE}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "문의 접수에 실패했습니다.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>문의하기</DialogTitle>
          <DialogDescription>
            궁금한 점이나 막힌 부분을 남겨 주세요. {INQUIRY_SLA_NOTICE}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>어떤 문의인가요?</Label>
            <RadioGroup
              value={category}
              onValueChange={(v) => setCategory(v as InquiryCategory)}
              className="gap-2"
            >
              {INQUIRY_CATEGORIES.map((c) => (
                <label
                  key={c}
                  htmlFor={`inq-cat-${c}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border bg-background p-3 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft/30"
                >
                  <RadioGroupItem id={`inq-cat-${c}`} value={c} />
                  {INQUIRY_CATEGORY_LABELS[c]}
                </label>
              ))}
            </RadioGroup>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inquiry-body">내용</Label>
            <Textarea
              id="inquiry-body"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="무엇이 궁금한지, 어디에서 막혔는지 적어 주세요."
            />
            <p className="text-right text-xs text-muted-foreground">{body.trim().length}/2000자</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            취소
          </Button>
          <Button onClick={() => void send()} disabled={sending}>
            {sending ? "보내는 중..." : "문의 보내기"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default InquiryComposer;
