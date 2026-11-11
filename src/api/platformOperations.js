/** The Angaza console's GraphQL documents. Served by platform-service; Angaza accounts only. */

const SCHOOL_FIELDS = `
  school_id name country country_name region region_label town time_zone status
  suspended_reason suspended_at suspended_by_name reactivated_at reactivated_by_name
  created_at created_by_name updated_at active_admin_count _version
`;

const ADMIN_FIELDS = 'teacher_id first_name last_name email status sign_in';

export const LIST_SCHOOLS = `query ListSchools {
  listSchools { ${SCHOOL_FIELDS} }
}`;

export const GET_SCHOOL = `query GetSchool($school_id: ID!) {
  getSchool(school_id: $school_id) {
    school { ${SCHOOL_FIELDS} }
    admins { ${ADMIN_FIELDS} }
    usage { classes teachers students }
  }
}`;

export const CREATE_SCHOOL = `mutation CreateSchool($input: CreateSchoolInput!) {
  createSchool(input: $input) { ${SCHOOL_FIELDS} }
}`;

export const UPDATE_SCHOOL = `mutation UpdateSchool($input: UpdateSchoolInput!) {
  updateSchool(input: $input) { ${SCHOOL_FIELDS} }
}`;

export const SUSPEND_SCHOOL = `mutation SuspendSchool($input: SuspendSchoolInput!) {
  suspendSchool(input: $input) { ${SCHOOL_FIELDS} }
}`;

export const REACTIVATE_SCHOOL = `mutation ReactivateSchool($input: SchoolRefInput!) {
  reactivateSchool(input: $input) { ${SCHOOL_FIELDS} }
}`;

export const ADD_SCHOOL_ADMIN = `mutation AddSchoolAdmin($input: AddSchoolAdminInput!) {
  addSchoolAdmin(input: $input) { admin { ${ADMIN_FIELDS} } temporary_password email { sent problem } }
}`;

export const RESET_SCHOOL_ADMIN_PASSWORD = `mutation ResetSchoolAdminPassword($input: ResetSchoolAdminPasswordInput!) {
  resetSchoolAdminPassword(input: $input) { admin { ${ADMIN_FIELDS} } temporary_password email { sent problem } }
}`;
