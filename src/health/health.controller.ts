import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Controller, Get, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { createSqsClient, WAGER_EVENTS_QUEUE_URL, WAGER_QUEUE_URL } from '../messaging/sqs.client';

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly sqs = createSqsClient();

  constructor(private readonly orm: MikroORM) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; dependencies: { postgres: 'ok'; sqs: 'ok' } }> {
    let postgres: 'ok' | 'unavailable' = 'ok';
    let sqs: 'ok' | 'unavailable' = 'ok';

    try {
      await this.orm.em.getConnection().execute('SELECT 1');
    } catch {
      postgres = 'unavailable';
    }

    try {
      await Promise.all([WAGER_QUEUE_URL, WAGER_EVENTS_QUEUE_URL].map((QueueUrl) =>
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] })),
      ));
    } catch {
      sqs = 'unavailable';
    }

    if (postgres !== 'ok' || sqs !== 'ok') {
      throw new ServiceUnavailableException({
        status: 'error',
        dependencies: { postgres, sqs },
      });
    }
    return { status: 'ok', dependencies: { postgres: 'ok', sqs: 'ok' } };
  }

  async onModuleDestroy(): Promise<void> {
    this.sqs.destroy();
  }
}
