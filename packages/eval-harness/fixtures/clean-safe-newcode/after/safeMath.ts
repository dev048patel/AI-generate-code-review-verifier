export function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function safeLast(items: number[]): number | undefined {
  if (items.length === 0) return undefined;
  return items[items.length - 1];
}
