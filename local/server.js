import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSchema, createYoga } from 'graphql-yoga';
import { verifyIdToken } from './cognito-auth.js';
import { RESOLVERS } from './resolvers.js';
import { startLambdaEndpoint } from './lambda-endpoint.js';
import { startEventBridgeEndpoint } from './eventbridge-endpoint.js';
import { startGoogleStandIn } from './google-stand-in.js';

const here = dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(join(here, '../graphql/schema/gradebook.graphql'), 'utf8');

function toAppSyncEvent(parentTypeName, fieldName, args, identity) {
  return {
    arguments: args,
    identity,
    info: { fieldName, parentTypeName, selectionSetList: [] },
    request: { headers: {} },
    source: null,
  };
}

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'appsync-local', ...o }));

const wrap = (parentTypeName, fieldName, service) => async (_root, args, ctx) => {
  const start = Date.now();
  try {
    const result = await service(toAppSyncEvent(parentTypeName, fieldName, args, ctx.identity));
    log({ field: fieldName, ms: Date.now() - start, ok: true, sub: ctx.identity?.sub });
    return result;
  } catch (e) {
    log({ field: fieldName, ms: Date.now() - start, ok: false, type: e.type, msg: e.message });
    // AppSync surfaces errorType; graphql-yoga surfaces extensions.
    const err = new Error(e.message);
    err.extensions = { errorType: e.type || 'InternalError', field: e.field };
    throw err;
  }
};

const resolvers = { Query: {}, Mutation: {} };
for (const [parent, fields] of Object.entries(RESOLVERS)) {
  for (const [field, service] of Object.entries(fields)) {
    resolvers[parent][field] = wrap(parent, field, service);
  }
}

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: '/graphql',
  cors: { origin: '*', credentials: true },
  maskedErrors: false,
  context: async ({ request }) => {
    const auth = request.headers.get('authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    return { identity: token ? await verifyIdToken(token) : null };
  },
});

const port = Number(process.env.PORT || 4000);
createServer((req, res) => yoga(req, res)).listen(port, () => {
  console.log(`AppSync (local) on http://localhost:${port}/graphql`);
});

startLambdaEndpoint(Number(process.env.LOCAL_LAMBDA_PORT || 4011));
startEventBridgeEndpoint(Number(process.env.LOCAL_EVENTS_PORT || 4010));
// Linking a Google account (My Profile) needs Google's account chooser; locally a stand-in plays it.
if (process.env.GOOGLE_STANDIN_URL) startGoogleStandIn(Number(new URL(process.env.GOOGLE_STANDIN_URL).port || 4012));
