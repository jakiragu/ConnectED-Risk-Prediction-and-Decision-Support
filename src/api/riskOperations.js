// GraphQL documents for risk predictions, their explanations and targets, and the risk model.

const FACTOR_SUMMARY = `top_factors { group label effect direction share all_missing }`;
const CHANGE_FIELDS = `column label group kind from to gain basis peer_window peer_count peer_change`;
const PREDICTION_FIELDS = `
  student_id admission_no first_name last_name class_id academic_year prediction_point probability at_risk threshold
  model_version missing_scores missing_attendance run_id predicted_at explained ${FACTOR_SUMMARY}
  targets_status best_target { ${CHANGE_FIELDS} }
`;

export const LIST_RISK_PREDICTIONS = `
  query ListRiskPredictions($school_id: ID!, $class_id: ID, $prediction_point: String!, $academic_year: Int) {
    listRiskPredictions(school_id: $school_id, class_id: $class_id, prediction_point: $prediction_point, academic_year: $academic_year) {
      ${PREDICTION_FIELDS}
    }
  }`;

export const GET_RISK_EXPLANATION = `
  query GetRiskExplanation($school_id: ID!, $student_id: ID!, $prediction_point: String!, $academic_year: Int) {
    getRiskExplanation(school_id: $school_id, student_id: $student_id, prediction_point: $prediction_point, academic_year: $academic_year) {
      explainer explained base_probability
      prediction { ${PREDICTION_FIELDS} }
      factors {
        group label effect direction share missing_columns all_missing
        columns { name label group value missing effect direction }
      }
      targets {
        selected_option selection_version selection_saved prediction_token
        status reason method target_point target_label evaluation_kind model_point threshold pass_mark
        missing_score_policy baseline_score baseline_at_risk dice_reason stats_available
        caps { column label max_increase max_value source }
        options { option_index method score at_risk changes { ${CHANGE_FIELDS} } }
      }
    }
  }`;

export const GET_RISK_IMPORTANCE = `
  query GetRiskImportance($school_id: ID!, $prediction_point: String!, $academic_year: Int, $class_id: ID) {
    getRiskImportance(school_id: $school_id, prediction_point: $prediction_point, academic_year: $academic_year, class_id: $class_id) {
      prediction_point academic_year model_version
      model { method rows groups { name label importance } features { name label importance } }
      observed { scope class_id students groups { name label importance } }
    }
  }`;

export const GET_RISK_RUN = `
  query GetRiskRun($school_id: ID!, $class_id: ID!, $term_id: ID!, $checkpoint: Checkpoint!) {
    getRiskRun(school_id: $school_id, class_id: $class_id, term_id: $term_id, checkpoint: $checkpoint) {
      run_id status trigger model_version threshold students at_risk with_targets targets_found targets_fallback targets_maintain targets_failed error started_at finished_at
    }
  }`;

export const GET_RISK_MODEL = `
  query GetRiskModel($school_id: ID!) {
    getRiskModel(school_id: $school_id) {
      available message model_version framework xgboost_version created_at source
      points { point features threshold metrics { f1 recall roc_auc } }
    }
  }`;

export const RUN_RISK_PREDICTIONS = `
  mutation RunRiskPredictions($input: RunRiskPredictionsInput!) {
    runRiskPredictions(input: $input) { run_id status trigger started_at }
  }`;
