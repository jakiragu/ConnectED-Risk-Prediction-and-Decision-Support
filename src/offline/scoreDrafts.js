import { cellText, tokenStatus } from '@gradebook/domain/score';

/**
 * The score-entry page's drafts, and the version each edit started from.
 *
 * The server detects that two people changed the same mark by comparing the
 * _version sent with the one it holds, so the version sent must be the one the
 * teacher was looking at when they began typing. The device copy of a mark can
 * change while the page is open (a queued mark reaches the server, another tab
 * pulls newer marks); sending the newest version then would tell the server
 * "I saw that change" when the teacher never did, and their save would
 * silently overwrite it.
 *
 * So each row being edited keeps a base: { version } as it was when editing
 * began. Rows not being edited follow the device copy, so a mark that changes
 * there (sent, refused, or held for a decision) changes on screen too.
 */

/** A cell's text in stored form ("abs" and "ABS" are the same mark). */
const asStored = (text) => {
  const t = String(text ?? '').trim();
  return tokenStatus(t) ? t.toUpperCase() : t;
};

/** Is the draft different from the mark the device holds? */
export const isChanged = (draft, score) => asStored(draft) !== cellText(score);

/**
 * After the teacher types in a row: start its base the first time it changes; drop the base
 * when the row is back to the mark the device holds, so it follows the device copy again.
 */
export function afterEdit(bases, studentId, draft, score) {
  if (!isChanged(draft, score)) {
    if (!(studentId in bases)) return bases;
    const { [studentId]: _done, ...rest } = bases;
    return rest;
  }
  if (studentId in bases) return bases;
  return { ...bases, [studentId]: { version: score?._version ?? null } };
}

/** The version to send for a row: the one its edit started from. */
export const versionFor = (bases, saved, studentId) =>
  studentId in bases ? bases[studentId].version : saved[studentId]?._version ?? null;

/** Rows not being edited show the device copy; rows being edited keep the teacher's draft. Same object if nothing changes. */
export function follow(drafts, bases, saved) {
  let next = drafts;
  for (const studentId of Object.keys(drafts)) {
    if (studentId in bases) continue;
    const text = cellText(saved[studentId]);
    if (asStored(drafts[studentId]) === text) continue;
    if (next === drafts) next = { ...drafts };
    next[studentId] = text;
  }
  return next;
}

/** After a save: these rows are no longer being edited (rejected rows stay, so they can be fixed). */
export function finish(bases, studentIds) {
  const done = new Set(studentIds);
  return Object.fromEntries(Object.entries(bases).filter(([id]) => !done.has(id)));
}
