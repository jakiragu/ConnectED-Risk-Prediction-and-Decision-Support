/** Sign-in methods: a person's own Google account linked to their ConnectED account. */
const SIGN_IN = `
  password google_linked google_email google_linked_at confirmed google_available can_link blocked_reason
`;

// ------------------------------------------------------- school staff (My Profile)
export const GET_SIGN_IN_METHODS = /* GraphQL */ `
  query GetSignInMethods($school_id: ID!) { getSignInMethods(school_id: $school_id) { ${SIGN_IN} } }
`;
export const START_GOOGLE_LINK = /* GraphQL */ `
  mutation StartGoogleLink($input: StartGoogleLinkInput!) { startGoogleLink(input: $input) { url state } }
`;
export const COMPLETE_GOOGLE_LINK = /* GraphQL */ `
  mutation CompleteGoogleLink($input: CompleteGoogleLinkInput!) { completeGoogleLink(input: $input) { signed_out sign_in { ${SIGN_IN} } } }
`;
export const REMOVE_GOOGLE_LINK = /* GraphQL */ `
  mutation RemoveGoogleLink($input: RemoveGoogleLinkInput!) { removeGoogleLink(input: $input) { signed_out sign_in { ${SIGN_IN} } } }
`;

// ------------------------------------------- school administrators (Settings > Accounts)
export const GET_ACCOUNT_POLICY = /* GraphQL */ `
  query GetAccountPolicy($school_id: ID!) { getAccountPolicy(school_id: $school_id) { school_id google_linking updated_at _version } }
`;
export const SAVE_ACCOUNT_POLICY = /* GraphQL */ `
  mutation SaveAccountPolicy($input: SaveAccountPolicyInput!) { saveAccountPolicy(input: $input) { school_id google_linking updated_at _version } }
`;
export const LIST_ACCOUNT_LINKS = /* GraphQL */ `
  query ListAccountLinks($school_id: ID!) {
    listAccountLinks(school_id: $school_id) {
      teacher_id first_name last_name email role status google_linked google_email google_linked_at confirmed
    }
  }
`;

/** Deletes a deactivated account for good (Teachers page). Needs a recent sign-in (ReauthRequired otherwise). */
export const DELETE_TEACHER = /* GraphQL */ `
  mutation DeleteTeacher($input: DeleteTeacherInput!) { deleteTeacher(input: $input) { teacher_id first_name last_name deleted_at } }
`;

// ------------------------------------------------ Angaza staff (the console's My Profile)
export const GET_STAFF_PROFILE = /* GraphQL */ `
  query GetStaffProfile { getStaffProfile { staff_id email first_name last_name status created_at sign_in { ${SIGN_IN} } } }
`;
export const START_STAFF_GOOGLE_LINK = /* GraphQL */ `
  mutation StartStaffGoogleLink { startStaffGoogleLink { url state } }
`;
export const COMPLETE_STAFF_GOOGLE_LINK = /* GraphQL */ `
  mutation CompleteStaffGoogleLink($input: CompleteStaffGoogleLinkInput!) { completeStaffGoogleLink(input: $input) { signed_out sign_in { ${SIGN_IN} } } }
`;
export const REMOVE_STAFF_GOOGLE_LINK = /* GraphQL */ `
  mutation RemoveStaffGoogleLink { removeStaffGoogleLink { signed_out sign_in { ${SIGN_IN} } } }
`;
