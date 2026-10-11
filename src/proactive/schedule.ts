import { DAY_MS, parseExplicitDueAt } from './due';
import type { ProactiveUserPreferences } from './types';

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function quickDueAt(
  choice: 'today' | 'tomorrow' | 'next-week',
  now: number,
  timeZone: string,
): number {
  const phrase = choice === 'today' ? '今天 18 点' : choice === 'tomorrow' ? '明天 18 点' : '下周一 18 点';
  const parsed = parseExplicitDueAt(phrase, now, timeZone);
  if (parsed !== undefined && parsed > now) return parsed;
  return now + (choice === 'today' ? 2 * 60 * 60 * 1_000 : choice === 'tomorrow' ? DAY_MS : 7 * DAY_MS);
}

export function localDayBounds(now: number, timeZone: string): { start: number; end: number } {
  const current = localParts(now, timeZone);
  const start = zonedDate(current.year, current.month, current.day, 0, 0, timeZone);
  const next = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const end = zonedDate(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    timeZone,
  );
  return { start, end };
}

/** Returns now when sending is allowed, otherwise the first instant after quiet hours. */
export function nextAllowedByQuietHours(
  now: number,
  preferences: ProactiveUserPreferences,
  timeZone: string,
): number {
  const quiet = preferences.quietHours;
  if (!quiet) return now;
  const startMinute = parseClock(quiet.start);
  const endMinute = parseClock(quiet.end);
  if (startMinute === undefined || endMinute === undefined || startMinute === endMinute) return now;
  const current = localParts(now, timeZone);
  const minute = current.hour * 60 + current.minute;
  const wraps = startMinute > endMinute;
  const blocked = wraps
    ? minute >= startMinute || minute < endMinute
    : minute >= startMinute && minute < endMinute;
  if (!blocked) return now;

  const target = new Date(Date.UTC(current.year, current.month - 1, current.day));
  if (wraps && minute >= startMinute) target.setUTCDate(target.getUTCDate() + 1);
  return zonedDate(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    Math.floor(endMinute / 60),
    endMinute % 60,
    timeZone,
  );
}

export function parseQuietHours(text: string): { start: string; end: string } | undefined {
  const normalized = text.replace(/[：]/g, ':');
  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(?:-|~|到|至)\s*(\d{1,2})(?::(\d{2}))?/);
  if (!match?.[1] || !match[3]) return undefined;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2] ?? 0);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4] ?? 0);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return undefined;
  return {
    start: `${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}`,
    end: `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`,
  };
}

function parseClock(value: string): number | undefined {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match?.[1] || !match[2]) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
}

function localParts(timestamp: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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
  };
}

function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let candidate = Date.UTC(year, month - 1, day, hour, minute);
  const targetAsUtc = candidate;
  for (let i = 0; i < 4; i++) {
    const observed = localParts(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    const difference = targetAsUtc - observedAsUtc;
    if (difference === 0) break;
    candidate += difference;
  }
  return candidate;
}
