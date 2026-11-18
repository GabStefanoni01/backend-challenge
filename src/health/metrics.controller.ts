import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Controller, Get, Header, OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { createSqsClient, WAGER_DLQ_URL } from '../messaging/sqs.client';

@Controller()
export class MetricsController implements OnModuleDestroy {
  private readonly sqs = createSqsClient();

  constructor(private readonly orm: MikroORM) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    const connection = this.orm.em.getConnection();
    const statuses = await connection.execute(
      'select status, count(*)::bigint as total from wager_transactions group by status',
    ) as Array<{ status: string; total: string }>;
    const counters = await connection.execute(
      'select name, value::text as value from operational_counters',
    ) as Array<{ name: string; value: string }>;
    const outbox = await connection.execute(
      `select count(*)::bigint as pending,
              coalesce(extract(epoch from now() - min(occurred_at)), 0)::text as lag_seconds
       from outbox_messages where published_at is null`,
    ) as Array<{ pending: string; lag_seconds: string }>;
    const references = await connection.execute(
      'select coalesce(sum(reference_attempts), 0)::bigint as total from wager_transactions',
    ) as Array<{ total: string }>;
    const latency = await connection.execute(
      `select coalesce(avg(extract(epoch from processed_at - created_at)), 0)::text as average
       from wager_transactions where processed_at is not null`,
    ) as Array<{ average: string }>;
    const locks = await connection.execute(
      `select count(*)::bigint as total from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and state = 'active'`,
    ) as Array<{ total: string }>;

    let dlqMessages = 0;
    try {
      const attributes = await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: WAGER_DLQ_URL,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      dlqMessages = Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0);
    } catch {
      // Keep metrics available even when the broker is temporarily unreachable.
    }

    const counterMap = new Map(counters.map((counter) => [counter.name, counter.value]));
    const lines = [
      '# HELP wager_transactions_total Wager transactions grouped by persisted status.',
      '# TYPE wager_transactions_total counter',
      ...statuses.map((row) => `wager_transactions_total{status="${row.status}"} ${row.total}`),
      '# HELP wager_idempotency_replays_total Requests served from a persisted idempotency result.',
      '# TYPE wager_idempotency_replays_total counter',
      `wager_idempotency_replays_total ${counterMap.get('idempotency_replays') ?? '0'}`,
      '# HELP sqs_duplicate_messages_total Duplicate SQS message deliveries ignored by the inbox.',
      '# TYPE sqs_duplicate_messages_total counter',
      `sqs_duplicate_messages_total ${counterMap.get('sqs_duplicate_messages') ?? '0'}`,
      '# HELP sqs_retries_total Transient SQS message retry attempts.',
      '# TYPE sqs_retries_total counter',
      `sqs_retries_total ${counterMap.get('sqs_retries') ?? '0'}`,
      '# HELP sqs_dlq_messages Approximate number of visible messages in the SQS dead-letter queue.',
      '# TYPE sqs_dlq_messages gauge',
      `sqs_dlq_messages ${dlqMessages}`,
      '# HELP outbox_publish_retries_total Failed outbox publication attempts.',
      '# TYPE outbox_publish_retries_total counter',
      `outbox_publish_retries_total ${counterMap.get('outbox_publish_retries') ?? '0'}`,
      '# HELP outbox_pending_messages Number of committed events waiting to be published.',
      '# TYPE outbox_pending_messages gauge',
      `outbox_pending_messages ${outbox[0]?.pending ?? '0'}`,
      '# HELP outbox_lag_seconds Age of the oldest unpublished outbox event.',
      '# TYPE outbox_lag_seconds gauge',
      `outbox_lag_seconds ${outbox[0]?.lag_seconds ?? '0'}`,
      '# HELP wager_reference_retries_total Pending reference retry attempts.',
      '# TYPE wager_reference_retries_total counter',
      `wager_reference_retries_total ${references[0]?.total ?? '0'}`,
      '# HELP postgres_lock_waiters Current PostgreSQL sessions waiting on locks.',
      '# TYPE postgres_lock_waiters gauge',
      `postgres_lock_waiters ${locks[0]?.total ?? '0'}`,
      '# HELP wager_processing_latency_seconds_avg Average time from transaction creation to terminal processing.',
      '# TYPE wager_processing_latency_seconds_avg gauge',
      `wager_processing_latency_seconds_avg ${latency[0]?.average ?? '0'}`,
    ];
    return lines.join('\n') + '\n';
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
