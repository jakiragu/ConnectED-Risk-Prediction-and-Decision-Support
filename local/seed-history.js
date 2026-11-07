import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE } from '../backend/library/keys.js';
import { calculateCheckpoint } from '../backend/library/results.js';
import * as results from '../backend/library/resultsRepo.js';
import * as assessments from '../backend/library/assessmentRepo.js';
import * as history from '../backend/library/historyRepo.js';
import * as risk from '../backend/library/riskRepo.js';
import * as interventions from '../backend/library/interventionRepo.js';
import { buildForStudent } from '../backend/library/featureStore.js';
import { linkFor } from '../backend/library/riskProfile.js';
import { groupOf } from '../backend/library/explanations.js';
import { handler as predict } from '../backend/lambdas/risk-prediction/handler.js';
import { seedInterventions } from './seed-interventions.js';

const put = (Item) => ddb.send(new PutCommand({ TableName: TABLE, Item }));

// Model subject names that differ from gradebook subject names.
const MODEL_TO_GRADEBOOK = { Religious_Education: 'CRE' };

// Counterfactual statuses produced by the risk scorer.
const SHOWS_TARGETS = new Set(['FOUND', 'FALLBACK']);

// Set SEED_ALLOW_NO_DICE=1 to report missing DiCE coverage as a warning instead of failing.
const ALLOW_NO_DICE = process.env.SEED_ALLOW_NO_DICE === '1';

/**
 * Rewrite top-level ISO timestamps (fields ending in _at) to `iso`.
 * Used only on seed records, so the record timeline matches the term calendar.
 */
function backdate(item, iso) {
  const out = { ...item };
  for (const [key, value] of Object.entries(out)) {
    if (key.endsWith('_at') && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) out[key] = iso;
  }
  if ('_lastChangedAt' in out) out._lastChangedAt = Date.parse(iso);
  return out;
}

/**
 * The gradebook subject that raised this student's risk the most, according to
 * the prediction's own SHAP values (summed over that subject's model inputs).
 * Attendance is excluded because seeded interventions are subject-level.
 */
function topRiskSubject(prediction, subjects) {
  const totals = new Map();
  for (const [column, effect] of Object.entries(prediction.shap_values || {})) {
    const group = groupOf(column);
    const subject = MODEL_TO_GRADEBOOK[group] ?? group;
    if (!subjects.includes(subject)) continue;
    totals.set(subject, (totals.get(subject) || 0) + Number(effect));
  }
  const raising = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return raising[0]?.[0] ?? null;
}

/** Who would log this intervention: the subject teacher, else the class teacher, else the admin. */
function interventionActor(staff, classId, subject, admin) {
  const subjectTeacher = staff.find((t) => t.assignments.some((a) => a.class_id === classId && a.subject === subject));
  const classTeacher = staff.find((t) => t.class_teacher_of === classId);
  const chosen = subjectTeacher || classTeacher;
  return chosen ? { sub: chosen.sub, name: chosen.name } : admin;
}

/** Seed-only orchestration; calculations, publication guards and ML use production code. */
export async function seedPublishedHistory({ schoolId, terms, classIds, items, staff, subjects, actor }) {
  const summary = { flagged: 0, interventions: 0, counterfactuals: {} };
  const interventionPredictions = [];
  const diceFoundByClass = new Map(classIds.map((c) => [c, 0]));
  const coverageProblems = [];

  const historyStartedAt = Date.now();

  function progress(message) {
    const elapsed = ((Date.now() - historyStartedAt) / 1000).toFixed(1);
    console.log(`[history +${elapsed}s] ${message}`);
  }

  for (const term of terms) {
    if (term.term_number !== 1) continue;
    
    for (const checkpoint of ['MIDTERM', 'ENDTERM']) {
      // T3F is the outcome, not a prediction checkpoint. Leave it available for demos.
      if (term.term_number === 3 && checkpoint === 'ENDTERM') continue;
      const date = checkpoint === 'MIDTERM' ? term.mid_term_date : term.end_date;
      const calculatedAt = `${date}T10:00:00.000Z`;
      const publishedAt = `${date}T11:00:00.000Z`;
      const predictedAt = `${date}T12:00:00.000Z`;
      const point = `T${term.term_number}${checkpoint === 'MIDTERM' ? 'M' : 'F'}`;

      for (const classId of classIds) {
        const classStartedAt = Date.now();
        progress(`Starting ${classId} ${point}...`);
        const scope = { termId: term.term_id, classId, checkpoint };
        const roster = items.filter((i) => i.entity === 'Student' && i.class_id === classId);
        const live = await assessments.listAllLive(schoolId, classId, term.term_id);
        const previous = checkpoint === 'ENDTERM'
          ? await results.getSet(schoolId, { ...scope, checkpoint: 'MIDTERM' }) : null;
        const previousRows = previous
          ? { MIDTERM: new Map((await results.listRows(schoolId, previous)).map((r) => [r.student_id, r])) } : {};
        const gradeRule = items.find((i) => i.entity === 'GradeRule' && i.term_id === term.term_id);
        const calculationStartedAt = Date.now();
        const calc = calculateCheckpoint({ checkpoint, assessments: live, roster, gradeRule,
          scoresByAssessment: new Map(live.map((a) => [a.assessment_id,
            items.filter((i) => i.entity === 'Score' && i.assessment_id === a.assessment_id)])),
          previousPublished: Boolean(previous), previousRows, openerEnabled: false,
        });
        if (calc.blocking) throw new Error(`Seed calculation blocked: ${classId} ${term.term_id} ${checkpoint}: ${JSON.stringify(calc.issues)}`);
        let set = await results.saveCalculation(schoolId, scope, {
          calculationId: `seed_${term.term_id}_${classId}_${checkpoint}`, calc, existing: null, actor,
          extra: { basis_opener_enabled: false, basis_weights_version: 0,
            basis_checkpoint_weights: gradeRule.checkpoint_weights ?? null,
            basis_previous: { OPENER: null, MIDTERM: previous?.calculation_id ?? null } },
        });
        set = await results.publish(schoolId, set, actor);
        // Backdate only seed records; never change the system clock or production APIs.
        set = { ...set, created_at: calculatedAt, calculated_at: calculatedAt,
          published_at: publishedAt, updated_at: publishedAt, _lastChangedAt: Date.parse(publishedAt) };
        await put(set);
        for (const row of await results.listRows(schoolId, set)) await put({ ...row, calculated_at: calculatedAt });
        for (const paper of await assessments.listAllLive(schoolId, classId, term.term_id)) {
          if (paper.published_in?.has(checkpoint)) await put({ ...paper, updated_at: publishedAt, _lastChangedAt: Date.parse(publishedAt) });
        }
        await history.writeHistory(schoolId, set, await results.listRows(schoolId, set), term);
        await history.markHistoryWritten(schoolId, set);
        progress(
          `${classId} ${point}: calculation, publication and history took ${((Date.now() - calculationStartedAt) / 1000).toFixed(1)}s`
        );

        const visibilityStartedAt = Date.now();

        // GSI2 attendance queries are eventually consistent. Wait for complete inputs.
        for (const student of roster) {
          for (let attempt = 0; ; attempt++) {
            const row = await buildForStudent(schoolId, student.student_id, point, 2026);
            if (!row.missing.scores.length && !row.missing.attendance.length) break;
            if (attempt === 7) throw new Error(`Seed inputs not visible: ${student.student_id} ${point}`);
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }

        progress(
          `${classId} ${point}: input visibility checks took ${((Date.now() - visibilityStartedAt) / 1000).toFixed(1)}s`
        );

        const predictionStartedAt = Date.now();

        // Await real scoring and counterfactual generation; no fabricated explanations.
        await predict({ action: 'run', school_id: schoolId, class_id: classId,
          term_id: term.term_id, checkpoint, requested_by: actor.sub });

        progress(
          `${classId} ${point}: prediction and explanation generation took ${((Date.now() - predictionStartedAt) / 1000).toFixed(1)}s`
        );

        const retrievalStartedAt = Date.now();

        const predictions = [];
        for (const student of roster) {
          const p = await risk.getPrediction(schoolId, 2026, point, student.student_id);
          if (!p || !p.shap_values || p.missing_scores || p.missing_attendance)
            throw new Error(`Incomplete seed prediction: ${classId} ${point} ${student.student_id}`);
          if (p.at_risk && (!p.counterfactuals || p.counterfactuals.status === 'ERROR'))
            throw new Error(`Seed counterfactual generation failed: ${student.student_id}: ${p.counterfactuals?.reason}`);
          // Prediction time follows publication, not the moment the seed ran.
          if (p.PK && p.SK) await put(backdate(p, predictedAt));
          else if (!summary.warnedKeys) {
            summary.warnedKeys = true;
            console.warn('  note: riskRepo.getPrediction does not return item keys; predictions keep run-time timestamps');
          }
          predictions.push(p);
        }
        interventionPredictions.push(...predictions);

        const flagged = predictions.filter((p) => p.at_risk);
        if (!flagged.length) throw new Error(`No flagged seed students: ${classId} ${point}`);
        summary.flagged += flagged.length;
        for (const p of flagged) {
          const status = p.counterfactuals.status;
          summary.counterfactuals[status] = (summary.counterfactuals[status] || 0) + 1;
          if (status === 'FOUND') diceFoundByClass.set(classId, diceFoundByClass.get(classId) + 1);
        }
        // Every class checkpoint must give teachers at least one set of improvement targets.
        if (!flagged.some((p) => SHOWS_TARGETS.has(p.counterfactuals.status))) {
          coverageProblems.push(`${classId} ${point}: no flagged student has improvement targets`);
        }

        const duration = ((Date.now() - classStartedAt) / 1000).toFixed(1);

        progress(
          `Completed ${classId} ${point}: ${predictions.length} students, ${flagged.length} flagged (${duration}s).`
        );

        progress(
          `${classId} ${point}: prediction retrieval took ${((Date.now() - retrievalStartedAt) / 1000).toFixed(1)}s`
        );
      }
    }
  }

  for (const [classId, found] of diceFoundByClass) {
    if (!found) coverageProblems.push(`${classId}: DiCE found no counterfactual at any checkpoint`);
  }
  if (coverageProblems.length) {
    const message = `Counterfactual/intervention coverage incomplete:\n  ${coverageProblems.join('\n  ')}`;
    if (!ALLOW_NO_DICE) throw new Error(`${message}\nRerun with SEED_ALLOW_NO_DICE=1 to accept this as a warning.`);
    console.warn(`WARNING: ${message}`);
  }
  const interventionSummary = await seedInterventions({
    schoolId,
    predictions: interventionPredictions,
    terms,
    staff,
    admin: actor,
  });

  summary.interventions = interventionSummary.created;
  delete summary.warnedKeys;
  return summary;
}
