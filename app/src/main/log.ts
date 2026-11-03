function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function log(scope: string, ...args: unknown[]): void {
  console.log(`${stamp()} [${scope}]`, ...args);
}

export function warn(scope: string, ...args: unknown[]): void {
  console.warn(`${stamp()} [${scope}]`, ...args);
}
