const endpoint = () =>
  import.meta.env?.VITE_GRAPHQL_ENDPOINT ||
  globalThis.CONNECTED_GRAPHQL_ENDPOINT ||
  'http://localhost:4000/graphql';

let tokenProvider = () => null;
export const setTokenProvider = (fn) => {
  tokenProvider = fn;
};

export class GraphQLError extends Error {
  constructor(message, errorType, field) {
    super(message);
    this.errorType = errorType;
    this.field = field;
  }
}

/** The school app's client: its token comes from AuthContext. */
export async function gql(query, variables = {}) {
  return send(await tokenProvider(), query, variables, sessionEnded); // may renew an expired token first (bounded, see AuthContext)
}

/**
 * Called when the API says this person's sessions were ended on purpose (a Google link was removed
 * or changed): the app signs out and the sign-in page says why. AuthContext registers it.
 */
let sessionEnded = () => {};
export const setSessionEndedHandler = (fn) => {
  sessionEnded = fn || (() => {});
};

/**
 * A client with its own sign-in, for the Angaza console: an Angaza session and
 * a school session can exist side by side without one sending the other's token.
 */
export const createClient = (getToken, { onSessionEnded } = {}) => async (query, variables = {}) =>
  send(await getToken(), query, variables, onSessionEnded);

/** Fired when the API says Angaza has suspended this school; Layout shows one clear page for it. */
export const SCHOOL_SUSPENDED_EVENT = 'connected:school-suspended';

async function send(token, query, variables, onSessionEnded) {
  // A request that never answers would leave a page on "Loading" for ever. Reads give up after
  // 30 seconds; changes (calculating or publishing a whole school) get longer.
  const isChange = /^\s*mutation\b/.test(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isChange ? 120_000 : 30_000);
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: endpoint().includes('.appsync-api.') ? token : `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new GraphQLError('The server took too long to answer. Try again.', 'Timeout');
    // fetch rejects only when the request never got a response.
    throw new GraphQLError('Cannot reach the server', 'Network');
  }

  if (!res.ok) throw new GraphQLError(`Server returned ${res.status}`, 'Transport');
  let body;
  try {
    body = await res.json();
  } catch {
    if (controller.signal.aborted) throw new GraphQLError('The server took too long to answer. Try again.', 'Timeout');
    throw new GraphQLError('The server sent an unreadable answer', 'Transport');
  } finally {
    clearTimeout(timer);
  }
  if (body.errors?.length) {
    const e = body.errors[0];
    if ((e.errorType || e.extensions?.errorType) === 'SchoolSuspended' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SCHOOL_SUSPENDED_EVENT, { detail: e.message }));
    }
    if ((e.errorType || e.extensions?.errorType) === 'SessionEnded') onSessionEnded?.(e.message);
    throw new GraphQLError(e.message, e.errorType || e.extensions?.errorType, e.errorInfo?.field || e.extensions?.field);
  }
  return body.data;
}