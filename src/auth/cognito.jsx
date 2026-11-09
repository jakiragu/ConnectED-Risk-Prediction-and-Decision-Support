import { refreshOAuth } from './oauth.js';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const endpoint = import.meta.env.VITE_COGNITO_ENDPOINT || undefined;
const client = new CognitoIdentityProviderClient({
  region: import.meta.env.VITE_AWS_REGION || 'eu-west-1',
  ...(endpoint ? { endpoint } : {}),
  credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' }, // public operations; never signed by the pool
});
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
/** The Angaza console's app client, in the Angaza staff pool. Every function below takes it as clientId. */
export const ANGAZA_CLIENT_ID = import.meta.env.VITE_PLATFORM_COGNITO_CLIENT_ID;

const MESSAGES = {
  NotAuthorizedException: 'Incorrect email or password',
  UserNotFoundException: 'Incorrect email or password',
  InvalidPasswordException: 'Choose a password of at least 8 characters with upper and lower case letters, a number and a symbol',
  PasswordResetRequiredException: 'Your password must be reset. Use Forgot password to choose a new one.',
};
const friendly = (e) => new Error(MESSAGES[e.name] || e.message || 'Sign-in failed');

const tokensFrom = (result, previousRefresh = null) => ({
  idToken: result.IdToken,
  refreshToken: result.RefreshToken || previousRefresh,
});

/** @returns {{tokens}|{challenge: 'NEW_PASSWORD_REQUIRED', session: string}} */
export async function signInWithPassword(email, password, clientId = CLIENT_ID) {
  try {
    const res = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED') return { challenge: res.ChallengeName, session: res.Session };
    if (res.ChallengeName) throw new Error(`This account needs ${res.ChallengeName}, which this app does not support yet`);
    return { tokens: tokensFrom(res.AuthenticationResult) };
  } catch (e) {
    throw friendly(e);
  }
}

/** First sign-in with a temporary password: the teacher chooses their own. clientId: see ANGAZA_CLIENT_ID. */
export async function completeNewPassword(email, session, newPassword, clientId = CLIENT_ID) {
  try {
    const res = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }));
    return { tokens: tokensFrom(res.AuthenticationResult) };
  } catch (e) {
    throw friendly(e);
  }
}

export async function refresh(refreshToken, clientId = CLIENT_ID, oauth = false) {
  if (oauth) return refreshOAuth(refreshToken, clientId);
  const res = await client.send(new InitiateAuthCommand({
    ClientId: clientId,
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  }));
  return tokensFrom(res.AuthenticationResult, refreshToken);
}
export async function requestPasswordReset(email, clientId = CLIENT_ID) {
  try {
    await client.send(new ForgotPasswordCommand({ ClientId: clientId, Username: email.trim().toLowerCase() }));
  } catch (e) { throw friendly(e); }
}
export async function confirmPasswordReset(email, code, password, clientId = CLIENT_ID) {
  try {
    await client.send(new ConfirmForgotPasswordCommand({ ClientId: clientId,
      Username: email.trim().toLowerCase(), ConfirmationCode: code.trim(), Password: password }));
  } catch (e) { throw friendly(e); }
}
