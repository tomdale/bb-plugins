/**
 * The wake times Snooze offers in the hold ring's outer band, worked out in
 * the viewer's time zone at the moment the ring opens. Earliest first;
 * Tomorrow is the default, and the band puts it directly outward from Snooze.
 */
export type SnoozePreset = {
  id: "hour" | "evening" | "tomorrow" | "weekend" | "week";
  label: string;
  /** The wake time as the band shows it under the label. */
  time: string;
  wakeAt: number;
  isDefault?: true;
};

const EVENING_HOUR = 18;
/** After this hour "This evening" is too close to be worth offering. */
const EVENING_CUTOFF_HOUR = 17;
const MORNING_HOUR = 9;

const formatTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const formatDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" });

export function snoozePresets(now: Date): SnoozePreset[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const list: SnoozePreset[] = [];

  const hour = new Date(now.getTime() + 60 * 60 * 1000);
  hour.setSeconds(0, 0);
  list.push({ id: "hour", label: "In 1 hour", time: formatTime(hour), wakeAt: hour.getTime() });

  if (now.getHours() < EVENING_CUTOFF_HOUR) {
    const evening = at(0, EVENING_HOUR);
    list.push({
      id: "evening",
      label: "This evening",
      time: formatTime(evening),
      wakeAt: evening.getTime(),
    });
  }

  const tomorrow = at(1, MORNING_HOUR);
  list.push({
    id: "tomorrow",
    label: "Tomorrow",
    time: `${formatDay(tomorrow)} ${formatTime(tomorrow)}`,
    wakeAt: tomorrow.getTime(),
    isDefault: true,
  });

  const dow = now.getDay();
  // Monday to Thursday only: on Friday, Saturday is tomorrow, and at the
  // weekend it has already begun.
  if (dow >= 1 && dow <= 4) {
    const saturday = at(6 - dow, MORNING_HOUR);
    list.push({
      id: "weekend",
      label: "This weekend",
      time: `${formatDay(saturday)} ${formatTime(saturday)}`,
      wakeAt: saturday.getTime(),
    });
  }

  // Next Monday, unless that is tomorrow.
  const toMonday = (8 - dow) % 7 || 7;
  if (toMonday > 1) {
    const monday = at(toMonday, MORNING_HOUR);
    list.push({
      id: "week",
      label: "Next week",
      time: `${formatDay(monday)} ${formatTime(monday)}`,
      wakeAt: monday.getTime(),
    });
  }
  return list;
}
