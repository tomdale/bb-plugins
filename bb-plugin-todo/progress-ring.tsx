const RADIUS = 5.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A 14px determinate ring for completed/total; decorative, so callers supply the text equivalent. */
export function ProgressRing({ completed, total, className }: { completed: number; total: number; className?: string }) {
  const fraction = total > 0 ? Math.min(1, completed / total) : 0;
  return <svg viewBox="0 0 14 14" className={className} aria-hidden="true" data-progress={fraction}>
    <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5} />
    {fraction > 0 && <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
      strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />}
  </svg>;
}
