import { assertClassTeacherOrAdmin, assertTenant } from '../../library/authz.js';
import { notFound, validation } from '../../library/errors.js';
import { CHECKPOINTS } from '../../library/results.js';
import * as results from '../../library/resultsRepo.js';
import * as platform from '../../library/platformRepo.js';
import * as smsRecords from '../../library/resultSmsRepo.js';
import { phoneHint, resultsSmsText, segments } from '../../library/resultsSms.js';
import { readiness, sendSms } from '../../library/sms.js';

/**
 * Telling parents a published result by SMS, from the Report cards page.
 * Who may: an administrator, or the class's class teacher (the same people who
 * see the class's report cards). Only published results are ever sent.
 */

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'results-sms', ...o }));

/** Messages in flight at once. Enough to send a class in a few seconds without hammering the provider. */
const PARALLEL = 5;
/** AppSync gives up on a request after 30 seconds; stop starting new messages well before that. */
const BUDGET_MS = 20_000;

/** Why a student's guardian gets no message, or null when they can be sent one. */
function reasonToSkip(student, record, { resend }) {
  if (!student?.guardian_phone) return 'no_number';
  if (student.results_sms === false) return 'opted_out';
  if (record?.status === smsRecords.SMS_STATUS.SENT && !resend) return 'already_sent';
  return null;
}

async function publishedScope(actor, input) {
  assertTenant(actor, input.school_id);
  if (!CHECKPOINTS.includes(input.checkpoint)) throw validation(`Checkpoint must be one of ${CHECKPOINTS.join(', ')}`, 'checkpoint');
  if (!input.class_id) throw validation('Choose a class', 'class_id');
  if (!input.term_id) throw validation('Choose a term', 'term_id');
  const klass = await platform.klass(input.school_id, input.class_id);
  if (!klass) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, input.class_id);
  const set = await results.getSet(input.school_id, { termId: input.term_id, classId: input.class_id, checkpoint: input.checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) throw validation('These results are not published, so they cannot be sent to parents', 'checkpoint');
  const [school, term] = await Promise.all([platform.school(input.school_id), platform.term(input.school_id, input.term_id)]);
  return {
    set,
    names: { schoolName: school?.name || 'School', className: klass.name, termName: term?.name || input.term_id },
  };
}

/** The SMS columns of the Report cards table, for listReportCards. */
export async function smsColumns(schoolId, set) {
  const records = await smsRecords.forSet(schoolId, set);
  return (student) => {
    const record = records.get(student.student_id);
    return {
      has_guardian_phone: Boolean(student.guardian_phone),
      results_sms: student.results_sms !== false,
      sms_status: record?.status ?? null,
      sms_at: record?.sent_at || record?.failed_at || record?.claimed_at || null,
      sms_problem: record?.problem ?? null,
      sms_to_hint: record?.to_hint ?? null,
    };
  };
}

/** What a message will say, for the confirmation step: one student's text, or the first one who would be sent. */
export async function previewResultsSms(actor, args) {
  const { set, names } = await publishedScope(actor, args);
  const ids = args.student_id ? [args.student_id] : (set.student_ids || []);
  if (args.student_id && !(set.student_ids || []).includes(args.student_id)) throw notFound('This student has no result in this class');
  const students = await platform.studentsByIds(args.school_id, ids);
  const pick = args.student_id
    ? students.get(args.student_id)
    : ids.map((id) => students.get(id)).find((s) => s?.guardian_phone && s.results_sms !== false) || students.get(ids[0]);
  const ready = readiness();
  if (!pick) return { student_id: null, student_name: null, text: null, segments: 0, ...ready };
  const row = await results.getRow(args.school_id, set, pick.student_id);
  if (!row) throw notFound('No published result for this student');
  const text = resultsSmsText({ set, row, student: pick, ...names });
  return {
    student_id: pick.student_id,
    student_name: `${pick.first_name} ${pick.last_name}`,
    text,
    segments: segments(text),
    ...ready,
  };
}

/**
 * Sends the published result to each chosen student's guardian (every student
 * in the class when none are chosen). Skips anyone without a number, anyone
 * whose guardian opted out, and anyone already sent this result unless
 * `resend`. Stops early, without failing what was sent, when the SMS account
 * cannot send at all or time runs short; pressing the button again finishes.
 */
export async function sendResultsSms(actor, input) {
  const ready = readiness();
  if (!ready.ready) throw validation(ready.problem);
  const { set, names } = await publishedScope(actor, input);

  const inClass = new Set(set.student_ids || []);
  const chosen = input.student_ids?.length ? [...new Set(input.student_ids)] : [...inClass];
  const stranger = chosen.find((id) => !inClass.has(id));
  if (stranger) throw validation('One of the chosen students has no result in this class', 'student_ids');

  const [students, rows, records] = await Promise.all([
    platform.studentsByIds(input.school_id, chosen),
    results.listRows(input.school_id, set).then((items) => new Map(items.map((r) => [r.student_id, r]))),
    smsRecords.forSet(input.school_id, set),
  ]);

  const outcome = { sent: 0, failed: 0, no_number: 0, opted_out: 0, already_sent: 0, not_attempted: 0, problem: null };
  const todo = [];
  for (const id of chosen) {
    const student = students.get(id);
    const skip = reasonToSkip(student, records.get(id), { resend: Boolean(input.resend) });
    if (skip) outcome[skip] += 1;
    else if (!rows.get(id)) outcome.not_attempted += 1;
    else todo.push(student);
  }

  const started = Date.now();
  let stop = null;
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !stop) {
      if (Date.now() - started > BUDGET_MS) {
        stop = stop || 'Time ran out before every message was sent. Press the button again to send the rest.';
        break;
      }
      const student = todo[next];
      next += 1;
      if (!(await smsRecords.claim(input.school_id, set, student.student_id, actor, { resend: Boolean(input.resend) }))) {
        outcome.already_sent += 1; // someone else is sending it, or just did
        continue;
      }
      const text = resultsSmsText({ set, row: rows.get(student.student_id), student, ...names });
      const result = await sendSms({ to: student.guardian_phone, text, kind: 'results' });
      await smsRecords.finish(input.school_id, set, student.student_id, actor, {
        ...result, to_hint: phoneHint(student.guardian_phone), segments: segments(text),
      });
      if (result.sent) outcome.sent += 1;
      else {
        outcome.failed += 1;
        if (result.fatal) stop = stop || result.problem;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  outcome.not_attempted += todo.length - next; // never started: stopped early
  outcome.problem = stop;

  log({ op: 'sendResultsSms', class_id: set.class_id, checkpoint: set.checkpoint, ...outcome, problem: undefined, stopped: Boolean(stop) });
  return outcome;
}
