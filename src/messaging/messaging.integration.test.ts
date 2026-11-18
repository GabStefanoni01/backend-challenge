import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../database/entities/wallet.entity';
import { WalletsService } from '../wallets/wallets.service';
import { CreateWagerTransactionDto } from '../wagering/dto/create-wager-transaction.dto';
import { WageringService } from '../wagering/wagering.service';
import { OutboxPublisher } from './outbox.publisher';
import { createSqsClient, WAGER_DLQ_URL, WAGER_EVENTS_QUEUE_URL, WAGER_QUEUE_URL } from './sqs.client';
import { WagerConsumer } from './wager.consumer';

setDefaultTimeout(60_000);

describe('SQS and transactional outbox integration', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let publisherA: OutboxPublisher;
  let publisherB: OutboxPublisher;

  beforeAll(async () => {
    const clientUrl = process.env.DATABASE_URL;
    if (!clientUrl) throw new Error('DATABASE_URL is required for messaging integration tests');
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl,
      entities: [WalletEntity],
      allowGlobalContext: true,
      pool: { min: 1, max: 10, acquireTimeoutMillis: 60_000 },
    });
    sqs = createSqsClient();
    await orm.em.getConnection().execute('delete from outbox_messages');

    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    const dlqAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl ?? WAGER_DLQ_URL,
      AttributeNames: ['QueueArn'],
    }));
    const dlqArn = dlqAttributes.Attributes?.QueueArn;
    if (!dlqArn) throw new Error('LocalStack did not return the DLQ ARN');

    await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '45',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '5' }),
      },
    }));
    await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-events.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));

    publisherA = new OutboxPublisher(orm);
    publisherB = new OutboxPublisher(orm);
  });

  afterAll(async () => {
    await publisherA?.onModuleDestroy();
    await publisherB?.onModuleDestroy();
    sqs?.destroy();
    await orm?.close(true);
  });

  it('claims an outbox row once across two concurrent publishers and publishes after commit', async () => {
    const eventId = randomUUID();
    const aggregateId = randomUUID();
    const event = {
      eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId,
      correlationId: aggregateId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: { transactionId: aggregateId, status: 'PROCESSED' },
    };

    await orm.em.getConnection().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       values (?, ?, ?, ?::jsonb, now())`,
      [eventId, aggregateId, event.eventType, JSON.stringify(event)],
    );

    const published = await Promise.all([
      publisherA.publishBatch(),
      publisherB.publishBatch(),
    ]);
    expect(published.reduce((total, count) => total + count, 0)).toBe(1);

    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: WAGER_EVENTS_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    }));
    const eventMessage = (received.Messages ?? []).find((message) =>
      message.Body?.includes(eventId),
    );
    expect(eventMessage).toBeDefined();
    if (eventMessage?.ReceiptHandle) {
      const body = JSON.parse(eventMessage.Body ?? '{}') as { eventId: string };
      expect(body.eventId).toBe(eventId);
      const row = await orm.em.getConnection().execute(
        'select published_at from outbox_messages where id = ?',
        [eventId],
      ) as Array<{ published_at: Date | null }>;
      expect(row[0]?.published_at).not.toBeNull();
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: WAGER_EVENTS_QUEUE_URL,
        ReceiptHandle: eventMessage.ReceiptHandle,
      }));
    }
  });

  it('consumes a real SQS request and acknowledges only after the financial commit', async () => {
    const wallets = new WalletsService(orm);
    const wagering = new WageringService(orm);
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `sqs-player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const wager: CreateWagerTransactionDto & { idempotencyKey: string } = {
      providerId: 'sqs-provider',
      externalTransactionId: `sqs-bet-${suffix}`,
      idempotencyKey: `sqs-key-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `sqs-round-${suffix}`,
      gameId: 'sqs-integration-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '10.00', currency: 'BRL' },
    };
    const body = JSON.stringify({
      messageId: `provider-message-${suffix}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: wager,
    });

    await sqs.send(new SendMessageCommand({
      QueueUrl: WAGER_QUEUE_URL,
      MessageBody: body,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID(),
    }));
    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: WAGER_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
    const message = received.Messages?.[0];
    expect(message?.ReceiptHandle).toBeDefined();
    expect(message?.MessageId).toBeDefined();

    const consumer = new WagerConsumer(wagering);
    const processMessage = (consumer as unknown as {
      processMessage: (value: {
        MessageId?: string;
        ReceiptHandle?: string;
        Body?: string;
        Attributes?: Record<string, string>;
      }) => Promise<void>;
    }).processMessage.bind(consumer);
    await processMessage(message!);

    const walletAfter = await wallets.findById(wallet.id);
    expect(walletAfter.balance.amount).toBe('90.00');
    const inbox = await orm.em.getConnection().execute(
      'select processed_at from inbox_messages where consumer_name = ? and message_id = ?',
      ['wager-transaction-consumer', message!.MessageId],
    ) as Array<{ processed_at: Date | null }>;
    expect(inbox[0]?.processed_at).not.toBeNull();

    const redelivery = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: WAGER_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
    }));
    expect(redelivery.Messages ?? []).toHaveLength(0);
    await consumer.onModuleDestroy();
  });
  it('routes a permanent malformed message to the real SQS dead-letter queue', async () => {
    const body = JSON.stringify({
      messageId: `invalid-${randomUUID()}`,
      type: 'UnsupportedMessageType',
      occurredAt: new Date().toISOString(),
      data: {},
    });
    await sqs.send(new SendMessageCommand({
      QueueUrl: WAGER_QUEUE_URL,
      MessageBody: body,
      MessageGroupId: 'invalid-message-test',
      MessageDeduplicationId: randomUUID(),
    }));
    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: WAGER_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }));
    const message = received.Messages?.[0];
    expect(message?.ReceiptHandle).toBeDefined();

    const consumer = new WagerConsumer(new WageringService(orm));
    const processMessage = (consumer as unknown as {
      processMessage: (value: {
        MessageId?: string;
        ReceiptHandle?: string;
        Body?: string;
        Attributes?: Record<string, string>;
      }) => Promise<void>;
    }).processMessage.bind(consumer);
    await processMessage(message!);

    const deadLetter = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: WAGER_DLQ_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }));
    expect(deadLetter.Messages?.[0]?.Body).toBe(body);
    const counters = await orm.em.getConnection().execute(
      "select value::text as value from operational_counters where name = 'sqs_dlq_messages'",
    ) as Array<{ value: string }>;
    expect(counters[0]?.value).toBe('1');

    if (deadLetter.Messages?.[0]?.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: WAGER_DLQ_URL,
        ReceiptHandle: deadLetter.Messages[0].ReceiptHandle,
      }));
    }
    await consumer.onModuleDestroy();
  });

});
