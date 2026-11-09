import { RESOLVERS } from '../../local/resolvers.js';
export async function handler(event) {
  const service = RESOLVERS[event.info?.parentTypeName]?.[event.info?.fieldName];
  if (!service) return { error: { message: 'Unknown operation', type: 'BadRequest' } };
  try { return { data: await service(event) }; }
  catch (error) { return { error: { message: error.message, type: error.type || 'InternalError', field: error.field } }; }
}
