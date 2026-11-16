import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SFNClient } from '@aws-sdk/client-sfn';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { LambdaClient } from '@aws-sdk/client-lambda';

const local = Boolean(process.env.DDB_ENDPOINT);

const base = {
  region: process.env.AWS_REGION || 'eu-west-1',
  ...(local
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
        },
      }
    : {}),
};

const at = (endpoint) => (endpoint ? { endpoint } : {});

export const ddb = DynamoDBDocumentClient.from(
  // A request DynamoDB throttles is retried with backoff; two more tries than the SDK's 3 ride out a
  // short burst on the 5-unit table without holding a page for long (AppSync gives up at 30 s).
  new DynamoDBClient({ ...base, maxAttempts: 5, ...at(process.env.DDB_ENDPOINT) }),
  { marshallOptions: { removeUndefinedValues: true } }
);

export const s3 = new S3Client({
  ...base,
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
});

export const eventBridge = new EventBridgeClient({ ...base, ...at(process.env.EVENTS_ENDPOINT) });

export const sfn = new SFNClient({ ...base, ...at(process.env.SFN_ENDPOINT) });

export const cognito = new CognitoIdentityProviderClient({ ...base, ...at(process.env.COGNITO_ENDPOINT) });

// Lambda-to-Lambda calls: the risk workflow and its scorer. LAMBDA_ENDPOINT is the local stand-in.
export const lambda = new LambdaClient({ ...base, ...at(process.env.LAMBDA_ENDPOINT) });

export const isLocal = local;