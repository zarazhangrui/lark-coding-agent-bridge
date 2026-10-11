const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_PROACTIVE_TIME_ZONE = 'Asia/Shanghai';

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface CalendarDateTime extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

interface ClockTime {
  hour: number;
  minute: number;
}

/** Parse only dates that are explicitly present in the message. */
export function parseExplicitDueAt(
  text: string,
  now: number,
  timeZone = DEFAULT_PROACTIVE_TIME_ZONE,
): number | undefined {
  const relativeMinutes = text.match(/([一二两三四五六七八九十\d]{1,3})\s*分钟后/);
  if (relativeMinutes?.[1]) {
    const minutes = parseCount(relativeMinutes[1]);
    if (minutes !== undefined) return now + minutes * 60 * 1_000;
  }

  if (/半\s*(?:个)?小时后/.test(text)) return now + 30 * 60 * 1_000;
  const relativeHours = text.match(/([一二两三四五六七八九十\d]{1,3})\s*(?:个)?小时后/);
  if (relativeHours?.[1]) {
    const hours = parseCount(relativeHours[1]);
    if (hours !== undefined) return now + hours * 60 * 60 * 1_000;
  }

  const today = zonedParts(now, timeZone);
  const clock = parseExplicitClock(text) ?? { hour: 18, minute: 0 };
  const relative = text.match(/([一二两三四五六七八九十\d]{1,3})\s*天后/);
  if (relative?.[1]) {
    const days = parseCount(relative[1]);
    if (days !== undefined) return zonedDate(addCalendarDays(today, days), clock, timeZone);
  }

  if (/大后天/.test(text)) return zonedDate(addCalendarDays(today, 3), clock, timeZone);
  if (/后天/.test(text)) return zonedDate(addCalendarDays(today, 2), clock, timeZone);
  if (/明天|明日/.test(text)) return zonedDate(addCalendarDays(today, 1), clock, timeZone);
  if (/今天|今日|今晚/.test(text)) return zonedDate(today, clock, timeZone);

  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    return zonedDate(
      { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      clock,
      timeZone,
    );
  }

  const monthDay = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]?/);
  if (monthDay) {
    let year = monthDay[1] ? Number(monthDay[1]) : today.year;
    let candidate = zonedDate(
      { year, month: Number(monthDay[2]), day: Number(monthDay[3]) },
      clock,
      timeZone,
    );
    if (candidate === undefined) return undefined;
    if (!monthDay[1] && candidate < now) {
      year += 1;
      candidate = zonedDate(
        { year, month: Number(monthDay[2]), day: Number(monthDay[3]) },
        clock,
        timeZone,
      );
    }
    return candidate;
  }

  const weekday = text.match(/(?:本|这|下)?(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const captured = weekday[1];
    if (!captured) return undefined;
    const wanted = '日一二三四五六'.indexOf(captured === '天' ? '日' : captured);
    const todayWeekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let delta: number;
    if (/下(?:周|星期)/.test(text)) {
      const daysToNextMonday = (8 - todayWeekday) % 7 || 7;
      const daysFromMonday = wanted === 0 ? 6 : wanted - 1;
      delta = daysToNextMonday + daysFromMonday;
    } else {
      delta = (wanted - todayWeekday + 7) % 7;
      const candidate = zonedDate(addCalendarDays(today, delta), clock, timeZone);
      if (delta === 0 && candidate !== undefined && candidate <= now) delta = 7;
    }
    return zonedDate(addCalendarDays(today, delta), clock, timeZone);
  }

  return undefined;
}

/**
 * Parse a new deadline after the model has already classified the message as
 * a postpone action. In that narrow context users commonly omit “后” and say
 * “改到 5 分钟吧”. Keeping this separate prevents bare durations in ordinary
 * chat from creating new follow-ups.
 */
export function parsePostponeDueAt(
  text: string,
  now: number,
  timeZone = DEFAULT_PROACTIVE_TIME_ZONE,
): number | undefined {
  const explicit = parseExplicitDueAt(text, now, timeZone);
  if (explicit !== undefined) return explicit;

  const relativeMinutes = text.match(/([一二两三四五六七八九十\d]{1,3})\s*分钟(?:吧|左右)?/);
  if (relativeMinutes?.[1]) {
    const minutes = parseCount(relativeMinutes[1]);
    if (minutes !== undefined) return now + minutes * 60 * 1_000;
  }

  if (/半\s*(?:个)?小时(?:吧|左右)?/.test(text)) return now + 30 * 60 * 1_000;
  const relativeHours = text.match(
    /([一二两三四五六七八九十\d]{1,3})\s*(?:个)?小时(?:吧|左右)?/,
  );
  if (relativeHours?.[1]) {
    const hours = parseCount(relativeHours[1]);
    if (hours !== undefined) return now + hours * 60 * 60 * 1_000;
  }

  return undefined;
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedDate(
  date: CalendarDate,
  clock: ClockTime,
  timeZone: string,
): number | undefined {
  if (!validCalendarDate(date) || !validClock(clock)) return undefined;
  const target: CalendarDateTime = { ...date, ...clock, second: 0 };
  let candidate = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    0,
    0,
  );

  // Convert a wall-clock time in an IANA zone into an instant. Re-evaluating
  // the offset handles zones with daylight-saving changes without mutating
  // process.env.TZ or depending on the host/container timezone.
  for (let i = 0; i < 4; i++) {
    const observed = zonedParts(candidate, timeZone);
    const difference = calendarAsUtc(target) - calendarAsUtc(observed);
    if (difference === 0) break;
    candidate += difference;
  }

  const observed = zonedParts(candidate, timeZone);
  return sameCalendarDateTime(observed, target) ? candidate : undefined;
}

function zonedParts(timestamp: number, timeZone: string): CalendarDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function calendarAsUtc(value: CalendarDateTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
}

function sameCalendarDateTime(a: CalendarDateTime, b: CalendarDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

function validCalendarDate(value: CalendarDate): boolean {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return (
    date.getUTCFullYear() === value.year &&
    date.getUTCMonth() === value.month - 1 &&
    date.getUTCDate() === value.day
  );
}

function validClock(value: ClockTime): boolean {
  return (
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59
  );
}

function parseExplicitClock(text: string): ClockTime | undefined {
  const match = text.match(
    /(?:(上午|中午|下午|傍晚|晚上|晚间|今晚)\s*)?(\d{1,2})\s*(?::|点|时)\s*(\d{1,2})?\s*分?/,
  );
  if (!match?.[2]) return undefined;
  let hour = Number(match[2]);
  const minute = match[3] === undefined ? 0 : Number(match[3]);
  const period = match[1];
  if (
    (period === '下午' ||
      period === '傍晚' ||
      period === '晚上' ||
      period === '晚间' ||
      period === '今晚') &&
    hour < 12
  ) {
    hour += 12;
  } else if (period === '中午' && hour < 11) {
    hour += 12;
  } else if (period === '上午' && hour === 12) {
    hour = 0;
  }
  const clock = { hour, minute };
  return validClock(clock) ? clock : undefined;
}

export function formatDueAt(
  timestamp: number,
  timeZone = DEFAULT_PROACTIVE_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export { DAY_MS };

function parseCount(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed >= 1 && parsed <= 99 ? parsed : undefined;
  }
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value[1] ?? ''] ?? 0);
  if (value.endsWith('十')) return (digits[value[0] ?? ''] ?? 0) * 10;
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (digits[tens ?? ''] ?? 0) * 10 + (digits[ones ?? ''] ?? 0);
  }
  return digits[value];
}
