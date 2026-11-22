import { assertAdmin, assertTenant } from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { resolvePlatformActor } from '../../library/platformActor.js';
import { notFound } from '../../library/errors.js';
import * as platform from '../../library/platformRepo.js';
import * as links from '../../library/accountLink.js';
import { deleteAccount } from '../../library/accountDeletion.js';
import { angazaRealm, policy as readPolicy, schoolRealm } from '../../library/accountLinkRepo.js';

/**
 * Sign-in methods: linking a person's own Google account to their ConnectED
 * account, for school staff (My Profile, Settings > Accounts) and Angaza staff
 * (the console's My Profile), and deleting a deactivated account for good. The
 * rules are in library/accountLink.js and library/accountDeletion.js; this file
 * only decides who is asking and whose account is meant.
 */
const STAFF_FIELDS = new Set(['getStaffProfile', 'startStaffGoogleLink', 'completeStaffGoogleLink', 'removeStaffGoogleLink']);

export async function handler(event) {
  const field = event.info.fieldName;
  return STAFF_FIELDS.has(field) ? staffHandler(event, field) : schoolHandler(event, field);
}

const result = (methods, extra = {}) => ({ signed_out: false, ...extra, sign_in: methods });

async function schoolHandler(event, field) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id ?? args.school_id);
  const realm = schoolRealm(actor.schoolId);
  const me = { sub: actor.sub, role: actor.role };

  switch (field) {
    case 'getSignInMethods':
      return links.signInMethods(realm, me);
    case 'startGoogleLink':
      return links.startLink(realm, actor);
    case 'completeGoogleLink': {
      const done = await links.completeLink(realm, actor, input.id_token);
      return result(await links.signInMethods(realm, me), { signed_out: done.changed });
    }
    case 'removeGoogleLink': {
      const other = input.teacher_id && input.teacher_id !== actor.sub;
      // Anyone may remove their own link, whatever the school's policy; only an administrator may remove someone else's.
      if (other) assertAdmin(actor);
      const record = other ? await platform.teacher(actor.schoolId, input.teacher_id) : null;
      if (other && (!record || platform.isDeleted(record))) throw notFound('That person is not registered at this school');
      const target = other
        ? { sub: record.teacher_id, email: record.email, firstName: record.first_name, role: record.role }
        : { sub: actor.sub, email: actor.email, firstName: actor.firstName, role: actor.role };
      await links.removeLink(realm, actor, target);
      return result(await links.signInMethods(realm, { sub: target.sub, role: target.role }), { signed_out: !other });
    }
    case 'getAccountPolicy':
      assertAdmin(actor);
      return policyView(await readPolicy(actor.schoolId));
    case 'saveAccountPolicy':
      assertAdmin(actor);
      return policyView(await links.savePolicy(realm, actor, input));
    case 'listAccountLinks': {
      assertAdmin(actor);
      const rows = await links.listLinks(realm, await platform.listStaff(actor.schoolId));
      return rows.map(({ person: p, ...link }) => ({
        teacher_id: p.teacher_id, first_name: p.first_name, last_name: p.last_name, email: p.email,
        role: p.role || 'Teacher', status: p.status || 'ACTIVE', ...link,
      }));
    }
    case 'deleteTeacher':
      assertAdmin(actor);
      return deleteAccount(realm, actor, input.teacher_id);
    default:
      throw notFound(`No handler for ${field}`);
  }
}

const policyView = (p) => ({ school_id: p.school_id, google_linking: p.google_linking, _version: p._version ?? 0, updated_at: p.updated_at ?? null });

/** Angaza staff: no school policy applies; the same proof, recent sign-in, audit and emails do. */
async function staffHandler(event, field) {
  const actor = await resolvePlatformActor(event);
  const realm = angazaRealm();
  const me = { sub: actor.sub, role: actor.role };
  const input = event.arguments?.input || {};

  switch (field) {
    case 'getStaffProfile':
      return {
        staff_id: actor.sub, email: actor.email, first_name: actor.staff.first_name ?? null, last_name: actor.staff.last_name ?? null,
        status: actor.staff.status || 'ACTIVE', created_at: actor.staff.created_at ?? null,
        sign_in: await links.signInMethods(realm, me),
      };
    case 'startStaffGoogleLink':
      return links.startLink(realm, actor);
    case 'completeStaffGoogleLink': {
      const done = await links.completeLink(realm, actor, input.id_token);
      return result(await links.signInMethods(realm, me), { signed_out: done.changed });
    }
    case 'removeStaffGoogleLink':
      await links.removeLink(realm, actor, { sub: actor.sub, email: actor.email, firstName: actor.firstName });
      return result(await links.signInMethods(realm, me), { signed_out: true });
    default:
      throw notFound(`No handler for ${field}`);
  }
}
