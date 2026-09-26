import type { ReactNode } from "react";
export const selectClass =
  "h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground";
export const muted = "text-sm text-muted-foreground";
export function ErrorMessage({ message }: { message?: string }) {
  return message ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {message}
    </p>
  ) : null;
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}
export function State({ value }: { value: string }) {
  const failed = /fail|error|stale|cancel/.test(value);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${failed ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {value}
    </span>
  );
}
export function pathFor(hostId: string, selector?: string) {
  return selector ? `${hostId}/${selector}` : hostId;
}
export function parseRoute(subPath: string) {
  try {
    const [hostId = "", ...parts] = subPath.split("/").map(decodeURIComponent);
    return { hostId, selector: parts.join("/") };
  } catch {
    return { hostId: "", selector: "" };
  }
}
