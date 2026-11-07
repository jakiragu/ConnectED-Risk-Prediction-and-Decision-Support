import { LIST_RISK_PREDICTIONS } from './riskOperations.js';

const POINTS = ['T1M', 'T1F', 'T2M', 'T2F', 'T3M'];

/** Only class teachers/admins may call the full-class prediction endpoint. */
export async function loadStudentRisk({ request, schoolId, classId, academicYear, allowed }) {
  if (!allowed) return new Map();
  const pages = await Promise.all(POINTS.map((prediction_point) => request(LIST_RISK_PREDICTIONS, {
    school_id: schoolId, class_id: classId, prediction_point,
    ...(academicYear != null ? { academic_year: Number(academicYear) } : {}),
  })));
  // Promise.all preserves checkpoint order, regardless of response order.
  const latest = new Map();
  for (const page of pages) {
    for (const prediction of page.listRiskPredictions || []) latest.set(prediction.student_id, prediction);
  }
  return latest;
}
