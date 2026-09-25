/** 各标的取数时刻可能不同，汇总显示最早的有效价格快照；缺时间不伪造当前时间。 */
export function quoteSnapshotTime(quotes: Record<string, { price: number | null; fetched_at?: string | null }>): number | null {
  const priced = Object.values(quotes).filter((q) => q.price !== null && Number.isFinite(q.price));
  if (!priced.length) return null;
  const times = priced.map((q) => q.fetched_at ? Date.parse(q.fetched_at) : NaN);
  return times.every(Number.isFinite) ? Math.min(...times) : null;
}
