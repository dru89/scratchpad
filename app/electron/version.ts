// Comparing release versions, for replacing a daemon an update left behind.

/** Whether version `a` is older than `b`, by their numeric parts: 0.1.9 is older than 0.1.10. */
export function isOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}
