import { forgotPasswordCode, passwordChanged } from '../../library/accountEmails.js';
import { sendEmail } from '../../library/mailer.js';

/**
 * Cognito calls this for both user pools (school and Angaza), at two moments:
 *
 *   CustomMessage_ForgotPassword          Cognito is about to email a reset code. We supply the
 *                                         wording; Cognito still writes in the code and sends it.
 *   PostConfirmation_ConfirmForgotPassword the reset finished. We email a "your password was
 *                                         changed" notice, which Cognito has no message for.
 *
 * Every other trigger source is passed straight back. Nothing here may throw: an error in a
 * Cognito trigger fails the person's request, and a nicer email is never worth a failed reset.
 * The portal is read from the account itself (school accounts carry custom:school_id), so one
 * function serves both pools without knowing their IDs.
 */
const portalOf = (attrs = {}) => (attrs['custom:school_id'] ? 'school' : 'angaza');
const firstNameOf = (attrs = {}) => String(attrs.name || '').trim().split(/\s+/)[0] || '';

export const makeHandler = (notify = sendEmail) => async (event) => {
  const attrs = event?.request?.userAttributes || {};
  try {
    if (event.triggerSource === 'CustomMessage_ForgotPassword') {
      const code = event.request.codeParameter; // Cognito's placeholder; it replaces it with the code
      const message = forgotPasswordCode({ to: attrs.email, firstName: firstNameOf(attrs), code, portal: portalOf(attrs) });
      if (code && message.html.includes(code)) {
        event.response = { ...event.response, emailSubject: message.subject, emailMessage: message.html };
      }
    } else if (event.triggerSource === 'PostConfirmation_ConfirmForgotPassword' && attrs.email) {
      await notify(passwordChanged({ to: attrs.email, firstName: firstNameOf(attrs), portal: portalOf(attrs) }));
    }
  } catch (error) {
    console.log(JSON.stringify({ level: 'warn', svc: 'auth-mail', trigger: event?.triggerSource, error: error?.name }));
  }
  return event;
};

export const handler = makeHandler();
