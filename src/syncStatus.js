// What Drive sync is doing right now, for the pill beside the Settings
// button (SyncStatusPill.js). Backups, cover uploads and restores each
// report as a job: beginSync() -> job.addTotal(n) / job.step() ->
// job.end({ ok, error, summary }). Jobs that overlap are one activity:
// their steps add up, so the bar never jumps back, and it's a Restore
// while any restore is part of it. A button that runs several in a row
// (Backup Now: CSVs, notes, then covers) wraps them in a job of its own,
// so they show as one.
//
// show: whether a job is worth the pill. Automatic backups that only
// write the CSVs are quick and stay hidden; Backup Now, Restore, Connect
// and cover uploads show it. A failure always shows, whatever `show` was,
// and stays until a later activity succeeds or the pill is tapped.

let jobs = [];
// The activity the running jobs belong to (null when nothing runs).
let activity = null;
// The last finished activity: { kind, ok, error, summary }, or null.
let result = null;
const listeners = new Set();

function emit() {
  const snapshot = getSyncStatus();
  listeners.forEach((l) => l(snapshot));
}

// { active: null | { kind, done, total, show }, result }
export function getSyncStatus() {
  if (!activity) return { active: null, result };
  const done = activity.done + jobs.reduce((n, j) => n + j.done, 0);
  const total = activity.total + jobs.reduce((n, j) => n + j.total, 0);
  return {
    active: { kind: activity.kind, done: Math.min(done, total), total, show: activity.show },
    result,
  };
}

export function onSyncStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Clears the shown result (the pill does this after showing a success,
// or when a failure is tapped).
export function clearSyncResult() {
  if (!result) return;
  result = null;
  emit();
}

// kind: 'backup' | 'restore'. Returns the job's handle.
export function beginSync(kind, { show = false, total = 0 } = {}) {
  if (!activity) activity = { kind, show: false, done: 0, total: 0, error: null, summary: null };
  if (kind === 'restore') activity.kind = 'restore';
  activity.show = activity.show || show;
  const job = { kind, done: 0, total };
  jobs.push(job);
  emit();
  return {
    addTotal(n) {
      job.total += n;
      emit();
    },
    step(n = 1) {
      job.done += n;
      emit();
    },
    // Records a failure without ending the job (it still counts as one
    // when the activity finishes).
    fail(error) {
      if (activity) activity.error = activity.error || error || 'Something went wrong.';
      emit();
    },
    // ok: false (with error) for a failure. summary: the text after the
    // tick, e.g. "Restored 12"; the activity's own kind's summary wins.
    end({ ok = true, error = null, summary = null } = {}) {
      if (!jobs.includes(job)) return;
      jobs = jobs.filter((j) => j !== job);
      activity.done += job.total; // a finished job counts as all done
      activity.total += job.total;
      if (!ok) activity.error = activity.error || error || 'Something went wrong.';
      if (summary && (kind === activity.kind || !activity.summary)) activity.summary = summary;
      if (!jobs.length) {
        const a = activity;
        activity = null;
        if (a.error) result = { kind: a.kind, ok: false, error: a.error, summary: null };
        else if (a.show || result?.ok === false) result = { kind: a.kind, ok: true, error: null, summary: a.summary };
      }
      emit();
    },
  };
}
