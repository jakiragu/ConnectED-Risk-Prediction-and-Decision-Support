// GraphQL documents for decision support: the teacher dashboard, a student's
// risk profile, interventions and the school-wide overview.

const SUMMARY = `prediction_point label probability at_risk threshold model_version predicted_at targets_status`;
const STUDENT = `student_id admission_no first_name last_name class_id class_name`;
const CHANGE = `column label group kind from to gain basis peer_window peer_count peer_change`;
const RESULTS = `point label average subjects { subject score grade }`;

const FACTORS = `
  group label effect direction share level missing_columns all_missing
`;

const TARGETS = `
  selected_option selection_version selection_saved prediction_token
  status reason method target_point target_label evaluation_kind model_point
  threshold pass_mark missing_score_policy baseline_score baseline_at_risk
  dice_reason stats_available partial
  caps { column label max_increase max_value source }
  options {
    option_index method score at_risk
    changes { ${CHANGE} }
  }
`;

export const INTERVENTION_FIELDS = `
  intervention_id student_id class_id factor method frequency status started_on stopped_on expected_outcome notes
  linked { academic_year prediction_point run_id model_version probability at_risk threshold predicted_at targets_status
           target { column label from to gain method } }
  outcome { from_point from_label to_point to_label from to change target_gain reached_target risk_from risk_to risk_to_point }
  created_by created_by_name created_at updated_by_name updated_at deleted _version
`;

export const GET_RISK_DASHBOARD = `
  query GetRiskDashboard($school_id: ID!) {
    getRiskDashboard(school_id: $school_id) {
      academic_year term_name classes students at_risk viewer_is_class_teacher
      at_risk_students { student { ${STUDENT} } latest { ${SUMMARY} } trend { prediction_point probability at_risk threshold } targets { ${CHANGE} } partial factors interventions }
      ongoing_interventions { intervention_id student_id student_name admission_no class_id class_name factor method frequency started_on created_by created_by_name assigned_by_me }
      pending_assessments { assessment_id class_name subject title assessment_type status missing due_date }
    }
  }`;

export const GET_STUDENT_RISK_PROFILE = `
  query GetStudentRiskProfile($school_id: ID!, $student_id: ID!, $academic_year: Int) {
    getStudentRiskProfile(school_id: $school_id, student_id: $student_id, academic_year: $academic_year) {
      student { ${STUDENT} status graduation_year }
      academic_year available_years year_class_name current last_published_point
      scope { all factors }
      latest { ${SUMMARY} }
      previous { ${SUMMARY} }
      base_probability explained
      factors { ${FACTORS} }
      targets { ${TARGETS} }
      assessment_history {
        prediction { ${SUMMARY} }
        base_probability
        explained
        factors { ${FACTORS} }
        targets { ${TARGETS} }
        results { ${RESULTS} }
        interventions { ${INTERVENTION_FIELDS} }
      }
      results { ${RESULTS} }
      risk_trend { ${SUMMARY} }
      performance_trend { ${RESULTS} }
      interventions { ${INTERVENTION_FIELDS} }
    }
  }`;

export const LIST_STUDENT_INTERVENTIONS = `
  query ListStudentInterventions($school_id: ID!, $student_id: ID!) {
    listStudentInterventions(school_id: $school_id, student_id: $student_id) { ${INTERVENTION_FIELDS} }
  }`;

export const LIST_INTERVENTION_METHODS = `
  query ListInterventionMethods($school_id: ID!, $factor: String) {
    listInterventionMethods(school_id: $school_id, factor: $factor) { factor method added_by_name teachers_used uses last_used_at }
  }`;

export const SAVE_INTERVENTION = `
  mutation SaveIntervention($input: SaveInterventionInput!) {
    saveIntervention(input: $input) { ${INTERVENTION_FIELDS} }
  }`;

export const DELETE_INTERVENTION = `
  mutation DeleteIntervention($input: DeleteInterventionInput!) {
    deleteIntervention(input: $input) { intervention_id student_id deleted _version }
  }`;

export const GET_SCHOOL_RISK_OVERVIEW = `
  query GetSchoolRiskOverview($school_id: ID!, $academic_year: Int) {
    getSchoolRiskOverview(school_id: $school_id, academic_year: $academic_year) {
      academic_year interventions_ongoing interventions_logged students_with_interventions
      points { point label students at_risk rate }
      forms { key label latest { point students at_risk rate } series { point students at_risk rate } }
      classes { key label interventions_ongoing interventions_logged latest { point students at_risk rate } series { point students at_risk rate } }
    }
  }`;

export const SELECT_STUDENT_TARGET = `
  mutation SelectStudentTarget($input: SelectStudentTargetInput!) {
    selectStudentTarget(input: $input) { selected_option selection_version selection_saved prediction_token }
  }`;
