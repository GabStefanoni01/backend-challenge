import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createSqsClient, WAGER_EVENTS_QUEUE_URL } from './sqs.client';

interface ClaimedOutboxMessage {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
  lock_token: string;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly client: SQSClient = createSqsClient();
  private stopping = false;
  private loop?: Promise<void>;

  constructor(private readonly orm: MikroORM) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.client.destroy();
  }

  async publishBatch(): Promise<number> {
    const connection = this.orm.em.getConnection();
    const claimed = await connection.execute(
      `with candidates as (
         select id from outbox_messages
         where published_at is null
           and next_attempt_at <= now()
           and (locked_until is null or locked_until < now())
         order by occurred_at, id
         for update skip locked
         limit 10
       )
       update outbox_messages as outbox
       set locked_until = now() + interval '45 seconds',
           lock_token = gen_random_uuid()
       from candidates
       where outbox.id = candidates.id
       returning outbox.id, outbox.aggregate_id, outbox.event_type,
                 outbox.payload, outbox.attempts, outbox.lock_token`,
    ) as ClaimedOutboxMessage[];

    for (const row of claimed) {
      try {
        const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
        await this.client.send(new SendMessageCommand({
          QueueUrl: WAGER_EVENTS_QUEUE_URL,
          MessageBody: body,
          MessageGroupId: row.aggregate_id,
          MessageDeduplicationId: row.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: row.event_type },
          },
        }));
        await connection.execute(
          `update outbox_messages
           set published_at = now(), locked_until = null, lock_token = null
           where id = ? and lock_token = ? and published_at is null`,
          [row.id, row.lock_token],
        );
      } catch (error) {
        await connection.execute(
          `update outbox_messages
           set attempts = attempts + 1,
               next_attempt_at = now() + make_interval(secs => least(300, power(2, least(attempts, 8))::int)),
               locked_until = null,
               lock_token = null
           where id = ? and lock_token = ? and published_at is null`,
          [row.id, row.lock_token],
        );
        await connection.execute(
          "insert into operational_counters (name, value) values ('outbox_publish_retries', 1) on conflict (name) do update set value = operational_counters.value + 1, updated_at = now()",
        );
        this.logger.error(JSON.stringify({
          event: 'outbox_publish_failed',
          outboxMessageId: row.id,
          eventType: row.event_type,
          error: error instanceof Error ? error.message : 'unknown',
        }));
      }
    }
    return claimed.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.publishBatch();
        if (count === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        this.logger.error(JSON.stringify({
          event: 'outbox_poll_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }));
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
