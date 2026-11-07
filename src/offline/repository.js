import { db, scoreKey } from './db.js';
import { gql } from '../api/graphql.js';
import {
  CREATE_ASSESSMENT,
  GET_ASSESSMENT,
  GET_ASSESSMENT_CONFIG,
  GET_CLASS_ROSTER,
  GET_GRADE_RULE,
  LIST_MY_CLASSES,
  RESOLVE_SCORE_CONFLICT,
  LIST_TERMS,
} from '../api/operations.js';
import {
  GET_RISK_DASHBOARD, GET_SCHOOL_RISK_OVERVIEW, GET_STUDENT_RISK_PROFILE, LIST_INTERVENTION_METHODS,
} from '../api/decisionOperations.js';
import * as outbox from './outbox.js';
import {
  discardIntervention, isOnline, queueAssessment, queueIntervention, queueScore, refreshAssessments, refreshScores,
} from './syncEngine.js';

/**
 * A read that still works offline: from the server when it can be reached
 * (and kept on this device), otherwise the copy kept last time.
 * onCached, when given, receives the device copy before the server is asked, so
 * a page can show it at once instead of a blank screen while the request runs.
 * @returns {Promise<{data:any, savedAt:string|null, fromDevice:boolean}>}
 */
async function readThrough(key, fetch, onCached = null) {
  if (onCached) {
    const kept = await db().cache.get(key);
    if (kept) onCached({ data: kept.value, savedAt: kept.saved_at, fromDevice: true, refreshing: true });
  }
  const fresh = await quietly(fetch);
  if (fresh != null) {
    const savedAt = new Date().toISOString();
    await db().cache.put({ key, value: fresh, saved_at: savedAt });
    return { data: fresh, savedAt, fromDevice: false };
  }
  const kept = await db().cache.get(key);
  return { data: kept?.value ?? null, savedAt: kept?.saved_at ?? null, fromDevice: Boolean(kept) };
}

/** Server interventions into the device copy; ones with changes still waiting keep the local version. */
async function mergeInterventions(studentId, items) {
  const local = await db().interventions.where('student_id').equals(studentId).toArray();
  const waiting = new Set(local.filter((i) => i._pending).map((i) => i.intervention_id));
  const server = new Set(items.map((i) => i.intervention_id));
  const gone = local.filter((i) => !server.has(i.intervention_id) && !i._pending && i._version != null).map((i) => i.intervention_id);
  await db().transaction('rw', db().interventions, async () => {
    if (gone.length) await db().interventions.bulkDelete(gone);
    await db().interventions.bulkPut(items.filter((i) => !waiting.has(i.intervention_id)).map((i) => ({ ...i, _server: i })));
  });
}


async function quietly(fn) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  try {
    return await fn();
  } catch (e) {
    if (e.errorType === 'Network') return null;
    throw e;
  }
}

export const repository = {
  loadClasses: (schoolId) =>
    quietly(async () => {
      const { listMyClasses } = await gql(LIST_MY_CLASSES, { school_id: schoolId });
      const current = new Set(listMyClasses.filter((c) => (c.status || 'CURRENT') === 'CURRENT').map((c) => c.class_id));
      await db().transaction('rw', db().classes, db().students, async () => {
        await db().classes.clear();
        await db().classes.bulkPut(listMyClasses);
        // After a promotion, rosters cached for archived classes are out of date (their students moved on).
        await db().students.filter((s) => !current.has(s.class_id)).delete();
      });
    }),

  loadRoster: (schoolId, classId) =>
    quietly(async () => {
      const { getClassRoster } = await gql(GET_CLASS_ROSTER, { school_id: schoolId, class_id: classId });
      await db().transaction('rw', db().students, async () => {
        await db().students.where('class_id').equals(classId).delete();
        await db().students.bulkPut(getClassRoster);
      });
    }),

  loadTerms: (schoolId) =>
    quietly(async () => {
      const { listTerms } = await gql(LIST_TERMS, { school_id: schoolId });
      await db().transaction('rw', db().terms, async () => {
        await db().terms.clear();
        await db().terms.bulkPut(listTerms);
      });
    }),

  loadAssessmentConfig: (schoolId) =>
    readThrough(`assessment-config:${schoolId}`, async () =>
      (await gql(GET_ASSESSMENT_CONFIG, { school_id: schoolId })).getAssessmentConfig
    ),

  /** A term's grading rule: whether it holds an Opener, and its checkpoint weights. Kept for offline use. */
  loadGradeRule: (schoolId, termId) =>
    readThrough(`grade-rule:${termId}`, async () =>
      (await gql(GET_GRADE_RULE, { school_id: schoolId, term_id: termId })).getGradeRule
    ),

  loadAssessment: (schoolId, assessmentId) =>
    quietly(async () => {
      const { getAssessment } = await gql(GET_ASSESSMENT, { school_id: schoolId, assessment_id: assessmentId });
      const cached = await db().assessments.get(assessmentId);
      if (getAssessment) await db().assessments.put(getAssessment);
      else if (cached && !cached._pending) await db().assessments.delete(assessmentId);
      return getAssessment;
    }),

  loadAssessments: (schoolId, classId, termId) => quietly(() => refreshAssessments(schoolId, classId, termId)),
  loadScores: (schoolId, assessmentId) => quietly(() => refreshScores(schoolId, assessmentId)),

  saveScore: queueScore,

  /** The device copy goes to onCached first (if there is one); the server's answer is returned. */
  loadDashboard: (schoolId, { onCached } = {}) =>
    readThrough(`dashboard:${schoolId}`, async () => (await gql(GET_RISK_DASHBOARD, { school_id: schoolId })).getRiskDashboard, onCached),

  /** Every roster of the teacher's classes, fetched side by side (for finding a student). */
  async loadRosters(schoolId) {
    await repository.loadClasses(schoolId);
    const classes = await db().classes.toArray();
    await Promise.all(classes.map((c) => repository.loadRoster(schoolId, c.class_id)));
  },

  loadSchoolOverview: (schoolId, academicYear = null) =>
    readThrough(`overview:${schoolId}:${academicYear ?? 'current'}`, async () =>
      (await gql(GET_SCHOOL_RISK_OVERVIEW, { school_id: schoolId, academic_year: academicYear })).getSchoolRiskOverview),

  /** A student's risk profile; its interventions also go into the device copy the intervention form works from. */
  async loadProfile(schoolId, studentId, year = null) {
    const out = await readThrough(year ? `profile:${studentId}:${year}` : `profile:${studentId}`, async () =>
      (await gql(GET_STUDENT_RISK_PROFILE, {
        school_id: schoolId,
        student_id: studentId,
        academic_year: year,
      })).getStudentRiskProfile);

    if (!out.data) return out;

    if (!out.fromDevice) {
      await mergeInterventions(studentId, out.data.interventions);

      // Refresh the logged-in teacher's class assignments.
      await repository.loadClasses(schoolId).catch(() => {});
    }

    // Find this student's class in the logged-in teacher's class list.
    const classId = out.data.student?.class_id;
    const klass = classId
      ? await db().classes.get(classId)
      : null;

    return {
      ...out,
      data: {
        ...out.data,
        teaching: {
          subjects: Array.isArray(klass?.my_subjects)
            ? klass.my_subjects
            : [],
          isClassTeacher: klass?.is_class_teacher === true,
        },
      },
    };
  },

  loadMethods: (schoolId, factor) =>
    readThrough(`methods:${factor}`, async () =>
      (await gql(LIST_INTERVENTION_METHODS, { school_id: schoolId, factor })).listInterventionMethods),

  /** Saved on this device at once and sent when the server can be reached. */
  saveIntervention: (input, actor) => queueIntervention({ action: 'SAVE', input, actor }),
  deleteIntervention: (item, actor) => queueIntervention({
    action: 'DELETE',
    input: { school_id: actor.schoolId, student_id: item.student_id, intervention_id: item.intervention_id },
    actor,
  }),
  discardIntervention,

  /** Online: create now, so validation errors come back to the form. Offline: queue. */
  async createAssessment(input, actor) {
    if (isOnline()) {
      try {
        const { createAssessment } = await gql(CREATE_ASSESSMENT, { input });
        await db().assessments.put(createAssessment);
        return { queued: false, assessment: createAssessment };
      } catch (e) {
        if (e.errorType !== 'Network') throw e;
      }
    }
    return { queued: true, assessment: await queueAssessment(input, actor) };
  },

  /** Deciding between two marks needs the server; it is online-only. */
  async resolveConflict({ schoolId, assessmentId, studentId, chosenRawScore, version }) {
    const { resolveScoreConflict } = await gql(RESOLVE_SCORE_CONFLICT, {
      input: {
        school_id: schoolId,
        assessment_id: assessmentId,
        student_id: studentId,
        chosen_raw_score: chosenRawScore,
        _version: version,
      },
    });
    const id = scoreKey(assessmentId, studentId);
    if (resolveScoreConflict) await db().scores.put({ ...resolveScoreConflict, id });
    else await db().scores.delete(id);
    await outbox.supersede(id);
    return resolveScoreConflict;
  },
};