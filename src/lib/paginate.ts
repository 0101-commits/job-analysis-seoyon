// PostgREST 는 한 요청당 최대 1000행만 돌려준다(db.max_rows).
// 전량이 필요한 집계/스냅샷/발송대상 조회는 이 헬퍼로 .range() 를 돌려 받는다.
const PAGE_SIZE = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/** page(from, to) 는 매번 새 쿼리를 만들어 .range(from, to) 를 건 것을 반환해야 한다. */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}
