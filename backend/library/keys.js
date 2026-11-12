export const TABLE = process.env.GRADEBOOK_TABLE_NAME || 'gradebook_platform_data';

const pad = (n) => String(n).padStart(16, '0');

export const pk = (schoolId) => `SCHOOL#${schoolId}`;

export const sk = {
  school: () => 'SCHOOL#PROFILE',
  term: (id) => `TERM#${id}`,
  termPrefix: () => 'TERM#',
  student: (id) => `STUDENT#${id}`,
  studentPrefix: () => 'STUDENT#',
  // Admission numbers are unique in a school; claimed in the same transaction as the student.
  admissionNo: (no) => `ADMNO#${no}`,
  teacher: (id) => `TEACHER#${id}`,
  teacherPrefix: () => 'TEACHER#',
  klass: (id) => `CLASS#${id}`,
  classPrefix: () => 'CLASS#',
  assessment: (id) => `ASSESSMENT#${id}`,
  assessmentConfig: () => 'ASSESSMENTCONFIG#SCHOOL',
  // One number per class + term + subject + exam + kind: Paper 1, CAT 1 and Quiz 1 can
  // all exist. Claimed in the same transaction as the assessment, so two components of
  // the same kind can never share a number. A paper keeps the key it always had, so
  // slots stored before kinds existed stay valid; other kinds add the kind to the key.
  paperSlot: (termId, classId, subject, assessmentType, paperNo, componentType = 'PAPER') =>
    `PAPER#${termId}#CLASS#${classId}#${subject}#${assessmentType}#` +
    `${componentType && componentType !== 'PAPER' ? `${componentType}#` : ''}${paperNo}`,
  score: (assessmentId, studentId) => `SCORE#${assessmentId}#${studentId}`,
  gradeRule: (termId) => `GRADERULE#${termId}`,
  gradingPolicy: () => 'GRADEPOLICY#DEFAULT',
  classSetup: () => 'CLASSSETUP#SCHOOL',
  // Results are published per class, so the term lock is per class.
  termLock: (termId, classId) => `TERMLOCK#${termId}#CLASS#${classId}`,
  // One result set per class + term + checkpoint: the unit that is reviewed and published.
  resultSet: (termId, classId, checkpoint) => `RESULTSET#${termId}#CLASS#${classId}#${checkpoint}`,
  resultSetClassPrefix: (termId, classId) => `RESULTSET#${termId}#CLASS#${classId}#`,
  resultSetTermPrefix: (termId) => `RESULTSET#${termId}#CLASS#`,
  // Rows live under their calculation id, so an abandoned or concurrent
  // recalculation never mixes into the rows a result set points at.
  termResult: (termId, classId, checkpoint, calculationId, studentId) =>
    `TERMRESULT#${termId}#CLASS#${classId}#${checkpoint}#${calculationId}#${studentId}`,
  termResultPrefix: (termId, classId, checkpoint, calculationId) =>
    `TERMRESULT#${termId}#CLASS#${classId}#${checkpoint}#${calculationId}#`,
  reportCard: (termId, checkpoint, studentId) => `REPORTCARD#${termId}#${checkpoint}#${studentId}`,
  reportCardPrefix: (termId, checkpoint) => `REPORTCARD#${termId}#${checkpoint}#`,
  reportCardDownload: (ulid) => `RCDOWNLOAD#${ulid}`,
  // The SMS that told a student's guardian about a published result (one per student, term and checkpoint).
  resultSms: (termId, checkpoint, studentId) => `RESULTSMS#${termId}#${checkpoint}#${studentId}`,
  resultSmsPrefix: (termId, checkpoint) => `RESULTSMS#${termId}#${checkpoint}#`,
  // A student's published result at one checkpoint, kept per class so a transfer loses nothing.
  studentResult: (studentId, termId, checkpoint, classId) => `STUDENTRESULT#${studentId}#${termId}#${checkpoint}#${classId}`,
  studentResultPrefix: (studentId) => `STUDENTRESULT#${studentId}#`,
  // Attendance for one student in one attendance period (a term's MIDTERM or ENDTERM period).
  attendance: (termId, period, studentId) => `ATTENDANCE#${termId}#${period}#${studentId}`,
  attendancePeriodPrefix: (termId, period) => `ATTENDANCE#${termId}#${period}#`,
  // The latest risk-prediction run for a published class checkpoint, and each student's latest prediction per point.
  riskRun: (termId, classId, checkpoint) => `RISKRUN#${termId}#${classId}#${checkpoint}`,
  risk: (academicYear, point, studentId) => `RISK#${academicYear}#${point}#${studentId}`,
  riskPointPrefix: (academicYear, point) => `RISK#${academicYear}#${point}#`,
  // A teacher's intervention for a student, under the student so their history is one query.
  intervention: (studentId, id) => `INTERVENTION#${studentId}#${id}`,
  interventionStudentPrefix: (studentId) => `INTERVENTION#${studentId}#`,
  // A method teachers have used for a factor, remembered once per wording (suggestions in the form).
  interventionMethod: (factor, key) => `INTVMETHOD#${factor}#${key}`,
  interventionMethodPrefix: (factor) => `INTVMETHOD#${factor ? `${factor}#` : ''}`,
  scoreAudit: (assessmentId, studentId, ulid) =>
    `SCOREAUDIT#${assessmentId}#${studentId}#${ulid}`,
  idempotency: (key) => `IDEMPOTENCY#${key}`,
  // Year-end promotion. The lock makes a school year promotable once (again only after an undo);
  // the run records what was decided; one move item per student makes the run resumable and undoable.
  // 'PROMOTION#' never matches 'PROMOTIONLOCK#' or 'PROMOTIONMOVE#' (the character after PROMOTION differs).
  promotionLock: (fromYear) => `PROMOTIONLOCK#${fromYear}`,
  promotionLockPrefix: () => 'PROMOTIONLOCK#',
  promotionRun: (runId) => `PROMOTION#${runId}`,
  promotionRunPrefix: () => 'PROMOTION#',
  promotionMove: (runId, studentId) => `PROMOTIONMOVE#${runId}#${studentId}`,
  promotionMovePrefix: (runId) => `PROMOTIONMOVE#${runId}#`,
};

export const gsi1 = {
  pk: (schoolId, classId) => `SCHOOL#${schoolId}#CLASS#${classId}`,
  assessment: (termId, assessmentId) => `TERM#${termId}#ASSESSMENT#${assessmentId}`,
  intervention: (id) => `INTERVENTION#${id}`,
  interventionPrefix: () => 'INTERVENTION#',
};

export const gsi2 = {
  pk: (schoolId, studentId) => `SCHOOL#${schoolId}#STUDENT#${studentId}`,
  score: (termId, assessmentId) => `TERM#${termId}#SCORE#${assessmentId}`,
  // A student's attendance across classes, ordered through the school year.
  attendance: (academicYear, termNumber, period) => `ATT#${academicYear}#${termNumber}#${period}`,
  attendanceYearPrefix: (academicYear) => `ATT#${academicYear}#`,
  risk: (academicYear, point) => `RISK#${academicYear}#${point}`,
  riskYearPrefix: (academicYear) => `RISK#${academicYear}#`,
};

export const gsi3 = {
  pk: (schoolId, classId) => `SCHOOL#${schoolId}#CLASS#${classId}#SCORE`,
  sk: (lastChangedAt) => pad(lastChangedAt),
};
/*
 * The Angaza console's records. Angaza staff work across schools, so their
 * records cannot live in any one school's partition. This partition is an index
 * of schools and a list of staff; a school's own data never moves here, and
 * nothing here is readable through a school's operations.
 */
export const PLATFORM_PK = 'PLATFORM';

export const platformSk = {
  // One registration per school: what the console lists. Mirrors the school's own SCHOOL#PROFILE.
  school: (schoolId) => `SCHOOL#${schoolId}`,
  schoolPrefix: () => 'SCHOOL#',
  // Claimed with the registration, so the same school cannot be added twice.
  // 'SCHOOL#' never matches 'SCHOOLNAME#' (the character after SCHOOL differs).
  schoolName: (key) => `SCHOOLNAME#${key}`,
  staff: (sub) => `STAFF#${sub}`,
  // Who did what to a school, newest last. Written with every change; read by no screen yet.
  audit: (schoolId, id) => `AUDIT#${schoolId}#${id}`,
};
