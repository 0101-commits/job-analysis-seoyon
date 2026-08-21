// 엑셀(.xlsx) 파일 생성 공용 헬퍼.
// 지금까지 화면마다 CSV 문자열을 조립해 개별 파일로 내려받았지만(BOM 처리 3곳 중복),
// v4부터 산출물·템플릿은 시트 여러 장을 담은 엑셀 한 파일로 통일한다.
// xlsx 패키지는 이미 설치돼 있었고(명부 읽기 전용) 여기서 처음 쓰기에 사용한다.
import * as XLSX from "xlsx";

export type SheetSpec = {
  /** 시트 이름 — 엑셀 제한(31자)에 맞춰 자른다 */
  name: string;
  /** 첫 행이 머리글, 이후가 데이터 행 */
  rows: (string | number | null | undefined)[][];
  /** 열 너비(문자 수). 생략하면 엑셀 기본값 */
  colWidths?: number[];
};

/** 시트 여러 장을 엑셀 한 파일로 만들어 즉시 내려받는다. 브라우저 전용. */
export function downloadXlsx(filename: string, sheets: SheetSpec[]) {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(
      sheet.rows.map((row) => row.map((cell) => cell ?? "")),
    );
    if (sheet.colWidths) ws["!cols"] = sheet.colWidths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 텍스트 파일(CSV·JSON) 내려받기 — 화면 3곳에 복제돼 있던 헬퍼의 단일본 */
export function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
