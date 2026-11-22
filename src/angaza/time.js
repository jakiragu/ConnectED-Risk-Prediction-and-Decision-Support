/**
 * "What time is it at that school?" for Angaza staff in other time zones.
 * Uses the browser's own time-zone data (Intl), so nothing is downloaded and
 * daylight saving on the viewer's side is handled for them.
 */

/** Minutes the zone is ahead of UTC at that moment (East Africa: +180). */
export function offsetMinutes(timeZone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const viewerOffset = (date) => -date.getTimezoneOffset();

const span = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
};

/** "3 h ahead of you", "7 h behind you", "Same time as you". */
export function differenceFromViewer(timeZone, date = new Date()) {
  const diff = offsetMinutes(timeZone, date) - viewerOffset(date);
  if (diff === 0) return 'Same time as you';
  return diff > 0 ? `${span(diff)} ahead of you` : `${span(-diff)} behind you`;
}

/**
 * The school's clock right now. hours: SCHOOL (Monday to Friday, 8:00 to 17:00
 * there), OUTSIDE (a weekday outside those hours) or WEEKEND. The day is shown
 * only when it differs from the viewer's, e.g. late evening in Toronto.
 */
export function schoolClock(timeZone, date = new Date()) {
  const en = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const hour = Number(en.hour) % 24;
  const weekend = en.weekday === 'Sat' || en.weekday === 'Sun';
  const hours = weekend ? 'WEEKEND' : hour >= 8 && hour < 17 ? 'SCHOOL' : 'OUTSIDE';
  const theirDay = `${en.year}-${en.month}-${en.day}`;
  const mine = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return {
    time: new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(date),
    day: theirDay !== mine ? new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short' }).format(date) : null,
    hours,
    difference: differenceFromViewer(timeZone, date),
  };
}

export const HOURS_LABEL = { SCHOOL: 'School hours', OUTSIDE: 'Outside school hours', WEEKEND: 'Weekend' };

/** The viewer's own clock, for the console header. */
export const myTime = (date = new Date()) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);

/** "3 Nov 2026, 14:05" in the viewer's own time. */
/** "16 Nov 2026" */
export const onDay = (iso) =>
  iso ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '';

export const when = (iso) =>
  iso ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
