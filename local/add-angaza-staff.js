import 'dotenv/config';
import * as platformIdentity from '../backend/library/platformIdentity.js';
import { putStaff, staff } from '../backend/library/platformStore.js';
import { invitation } from '../backend/library/accountEmails.js';
import { sendEmail } from '../backend/library/mailer.js';

/**
 * Gives an Angaza colleague access to the Angaza console. The console never
 * creates Angaza accounts itself, so this is the one way in (locally and on AWS).
 *
 *   npm run angaza:add-staff -- --email jane@angazacenter.org --first Jane --last Wanjiru
 *
 * Emails them a temporary password (and prints it once, in case the email does
 * not arrive); they choose their own at first sign-in.
 */
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] || '').trim() : '';
};

const email = arg('email').toLowerCase();
const first = arg('first');
const last = arg('last');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !first || !last) {
  console.log('Usage: npm run angaza:add-staff -- --email <email> --first <first name> --last <last name>');
  process.exit(1);
}

const account = await platformIdentity.createStaffAccount({ email, name: `${first} ${last}` });
if (!(await staff(account.sub))) {
  await putStaff({ staff_id: account.sub, email, first_name: first, last_name: last });
}
if (!account.created) {
  console.log(`${email} already had an Angaza account; it can use the console now.`);
} else {
  const delivery = await sendEmail(invitation({ to: email, firstName: first, temporaryPassword: account.temporaryPassword, role: 'PlatformAdmin', portal: 'angaza' }));
  console.log(`Added ${first} ${last} (${email}). Temporary password: ${account.temporaryPassword}`);
  console.log(delivery.sent
    ? 'Their invitation was emailed to them. The password above is only for if it does not arrive.'
    : `The invitation was not emailed (${delivery.problem}) Give them the password yourself.`);
  console.log('They choose their own password the first time they sign in at /angaza.');
}
