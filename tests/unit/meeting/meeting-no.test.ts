import { describe, expect, it } from 'vitest';
import { extractMeetingNo } from '../../../src/meeting/api';

describe('extractMeetingNo', () => {
  it.each([
    ['123456789', '123456789'],
    ['会议号 123 456 789 进来', '123456789'],
    ['https://vc.example.com/j/123456789?pwd=987654321', '123456789'],
    ['123-456-789', '123456789'],
    ['能进吗? 123456789', '123456789'],
    ['会议 #123456789', '123456789'],
  ])('%s', (input, want) => {
    expect(extractMeetingNo(input)).toEqual({ ok: true, meetingNo: want });
  });

  it('does not cut 9 digits out of a phone number', () => {
    expect(extractMeetingNo('打 13812345678')).toEqual({ ok: false, reason: 'none' });
  });

  it('reports two numbers as ambiguous, not as none', () => {
    expect(extractMeetingNo('123456789 987654321')).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: ['123456789', '987654321'],
    });
  });
});
