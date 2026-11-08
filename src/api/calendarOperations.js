// GraphQL documents for the school calendar, attendance and the risk model's inputs.

const TERM_FIELDS = `
  term_id name academic_year term_number start_date mid_term_date end_date status school_days _version
  closures { from to label }
  periods { period label from to school_days }
`;
const ENTRY_FIELDS = `days_attended days_excused days_absent percentage recorded_by_name recorded_at _version`;

export const LIST_TERMS_FULL = `
  query ListTermsFull($school_id: ID!) { listTerms(school_id: $school_id) { ${TERM_FIELDS} } }`;

export const CREATE_TERM = `
  mutation CreateTerm($input: CreateTermInput!) { createTerm(input: $input) { ${TERM_FIELDS} } }`;

export const UPDATE_TERM = `
  mutation UpdateTerm($input: UpdateTermInput!) { updateTerm(input: $input) { ${TERM_FIELDS} } }`;

export const GET_CLASS_ATTENDANCE = `
  query GetClassAttendance($school_id: ID!, $class_id: ID!, $term_id: ID!, $period: AttendancePeriodName!) {
    getClassAttendance(school_id: $school_id, class_id: $class_id, term_id: $term_id, period: $period) {
      class_id class_name term_id term_name academic_year period period_label from to school_days locked can_edit
      students { student_id admission_no first_name last_name year_to_date year_to_date_missing entry { ${ENTRY_FIELDS} } }
    }
  }`;

export const SUBMIT_ATTENDANCE = `
  mutation SubmitAttendance($input: SubmitAttendanceInput!) {
    submitAttendance(input: $input) {
      accepted rejected conflicted
      results { student_id outcome reason entry { ${ENTRY_FIELDS} } }
    }
  }`;

export const GET_FEATURE_READINESS = `
  query GetFeatureReadiness($school_id: ID!, $class_id: ID, $prediction_point: String!, $academic_year: Int) {
    getFeatureReadiness(school_id: $school_id, class_id: $class_id, prediction_point: $prediction_point, academic_year: $academic_year) {
      class_id class_name academic_year prediction_point columns complete
      students { student_id class_id admission_no first_name last_name missing_scores missing_attendance notes complete }
    }
  }`;

export const GET_STUDENT_FEATURES = `
  query GetStudentFeatures($school_id: ID!, $student_id: ID!, $prediction_point: String!, $academic_year: Int) {
    getStudentFeatures(school_id: $school_id, student_id: $student_id, prediction_point: $prediction_point, academic_year: $academic_year) {
      student_id academic_year prediction_point missing_scores missing_attendance notes complete
      values { name value }
    }
  }`;