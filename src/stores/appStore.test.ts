import { describe, expect, it } from 'vitest';
import { applySessionToEntries, newestSession, previewSnapshot, type DictationEntry } from './appStore';

describe('session event ordering', () => {
  it('ignores late results from a cancelled earlier task', () => {
    const current = { ...previewSnapshot.session, id: 3, phase: 'recording' as const };
    const late = { ...previewSnapshot.session, id: 2, phase: 'done' as const, output: 'old result' };
    expect(newestSession(current, late)).toBe(current);
  });
  it('keeps a completed phase when a delayed recording event arrives', () => {
    const current = { ...previewSnapshot.session, id: 3, phase: 'done' as const, output: 'new result' };
    const late = { ...current, phase: 'recording' as const };
    expect(newestSession(current, late)).toBe(current);
  });
  it('uses the native event sequence to reject a delayed partial event', () => {
    const current = { ...previewSnapshot.session, id: 3, revision: 12, phase: 'done' as const, output: '最终结果' };
    const late = { ...current, revision: 11, phase: 'recording' as const, partialTranscript: '旧半句' };
    expect(newestSession(current, late)).toBe(current);
  });
  it('accepts a new task after completion', () => {
    const current = { ...previewSnapshot.session, id: 3, phase: 'done' as const };
    const next = { ...previewSnapshot.session, id: 4, phase: 'recording' as const };
    expect(newestSession(current, next)).toBe(next);
  });
});

describe('dictation entries', () => {
  const done = (id: number, output: string, elapsedMs: number, transcript = '') =>
    ({ ...previewSnapshot.session, id, phase: 'done' as const, output, transcript, elapsedMs });
  it('turns a finished recording into a new entry with duration', () => {
    const entries = applySessionToEntries([], null, done(5, '明天开会', 8300));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 5, text: '明天开会', durationMs: 8300 });
  });
  it('appends partial and committed speech into one live entry', () => {
    const partial = { ...previewSnapshot.session, id: 5, phase: 'recording' as const, partialTranscript: '正在说话', elapsedMs: 800 };
    const first = applySessionToEntries([], null, partial);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ text: '', partialText: '正在说话', live: true });
    const committed = { ...partial, transcript: '前半句。', partialTranscript: '', elapsedMs: 1500 };
    const second = applySessionToEntries(first, null, committed);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ text: '前半句。', partialText: '', live: true });
    const final = applySessionToEntries(second, null, done(5, '前半句。后半句。', 1500));
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ text: '前半句。后半句。', live: false });
    expect(final[0].partialText).toBeUndefined();
  });
  it('updates the same session in place instead of duplicating', () => {
    const first = applySessionToEntries([], null, done(5, '草稿', 4000));
    const second = applySessionToEntries(first, null, done(5, '润色后的草稿', 4000, '草稿'));
    expect(second).toHaveLength(1);
    expect(second[0].text).toBe('润色后的草稿');
    expect(second[0].rawTranscript).toBe('草稿');
    expect(second[0].createdAt).toBe(first[0].createdAt);
  });
  it('writes a UI polish result back into its target entry', () => {
    const entry: DictationEntry = { id: 99, text: '原文', rawTranscript: '', durationMs: 5000, createdAt: 1 };
    const entries = applySessionToEntries([entry], 99, done(7, '润色结果', 0, '原文'));
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('润色结果');
    expect(entries[0].durationMs).toBe(5000);
  });
  it('never lets a dangling polish target swallow a recording result', () => {
    const entry: DictationEntry = { id: 99, text: '原文', rawTranscript: '', durationMs: 5000, createdAt: 1 };
    const entries = applySessionToEntries([entry], 99, done(8, '新的听写', 6000));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 8, text: '新的听写' });
    expect(entries[1].text).toBe('原文');
  });
  it('ignores cancelled, failed or empty sessions', () => {
    const cancelled = { ...previewSnapshot.session, id: 6, phase: 'cancelled' as const };
    expect(applySessionToEntries([], null, cancelled)).toEqual([]);
    expect(applySessionToEntries([], null, done(6, '   ', 3000))).toEqual([]);
  });
  it('drops a cancelled live entry without creating a completed record', () => {
    const live = { ...previewSnapshot.session, id: 6, phase: 'recording' as const, transcript: '第一句。', partialTranscript: '未完成' };
    const entries = applySessionToEntries([], null, live);
    const cancelled = { ...live, id: 7, phase: 'cancelled' as const, partialTranscript: '' };
    expect(applySessionToEntries(entries, null, cancelled)).toEqual([]);
  });
  it('cancelling a new attempt never deletes an older completed entry', () => {
    const completed = applySessionToEntries([], null, done(5, '已完成', 5000));
    const cancelled = { ...previewSnapshot.session, id: 6, phase: 'cancelled' as const };
    expect(applySessionToEntries(completed, null, cancelled)).toEqual(completed);
  });
  it('keeps confirmed text but removes a temporary fragment on failure', () => {
    const live = { ...previewSnapshot.session, id: 6, phase: 'recording' as const, transcript: '已确认。', partialTranscript: '旧半句' };
    const entries = applySessionToEntries([], null, live);
    const failed = { ...live, phase: 'error' as const, partialTranscript: '', error: '识别失败' };
    const settled = applySessionToEntries(entries, null, failed);
    expect(settled[0]).toMatchObject({ text: '已确认。', live: false });
    expect(settled[0].partialText).toBeUndefined();
  });
});
