import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT ?? process.env.AWS_ENDPOINT_URL;
  const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    : endpoint ? { accessKeyId: 'test', secretAccessKey: 'test' } : undefined;

  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    credentials,
    maxAttempts: 3,
  });
}

export const WAGER_QUEUE_URL =
  process.env.WAGER_QUEUE_URL ?? process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
export const WAGER_DLQ_URL =
  process.env.WAGER_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

export const WAGER_EVENTS_QUEUE_URL =
  process.env.WAGER_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo';
