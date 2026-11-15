import { classLabel, isCurrent } from './classLabels.js';

/**
 * How the signed-in user's role is shown (top bar and dashboard). The role is the
 * Cognito group; "class teacher" is not a separate role but a duty on a class, so
 * it is shown as a detail of the Teacher role.
 */
export function describeRole({ isAdmin, classes = [] }) {
  const own = classes.filter((c) => c.is_class_teacher && isCurrent(c));
  return {
    role: isAdmin ? 'Administrator' : 'Teacher',
    detail: own.length ? `Class teacher of ${own.map((c) => classLabel(c, classes)).join(', ')}` : null,
  };
}
