import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { CreateWagerTransactionDto } from '../wagering/dto/create-wager-transaction.dto';
import { WageringService } from '../wagering/wagering.service';
import { createSqsClient, WAGER_DLQ_URL, WAGER_QUEUE_URL } from './sqs.client';

interface WagerMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: CreateWagerTransactionDto & { idempotencyKey: string };
}

@Injectable()
export class WagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerConsumer.name);
  private readonly client: SQSClient = createSqsClient();
  private stopping = false;
  private loop?: Promise<void>;
  private readonly consumerName = 'wager-transaction-consumer';

  constructor(private readonly wagering: WageringService) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.client.destroy();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: WAGER_QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 10,
          VisibilityTimeout: 45,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));

        for (const message of response.Messages ?? []) {
          if (this.stopping) break;
          if (!message.ReceiptHandle || !message.Body) continue;
          await this.processMessage(message);
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.error(JSON.stringify({
          event: 'sqs_consume_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }));
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async processMessage(message: {
    MessageId?: string;
    ReceiptHandle?: string;
    Body?: string;
    Attributes?: Record<string, string>;
  }): Promise<void> {
    const receiptHandle = message.ReceiptHandle!;
    const body = message.Body!;
    const messageId = message.MessageId ?? createHash('sha256').update(body).digest('hex');

    try {
      const envelope = JSON.parse(body) as WagerMessage;
      if (envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
        throw new BadRequestException('Unsupported SQS message envelope');
      }

      const { idempotencyKey, ...wagerInput } = envelope.data;
      if (!idempotencyKey) throw new BadRequestException('Message is missing idempotencyKey');

      const dto = plainToInstance(CreateWagerTransactionDto, wagerInput);
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      if (errors.length > 0) throw new BadRequestException('Invalid wager message payload');

      const payloadHash = createHash('sha256').update(body).digest('hex');
      const result = await this.wagering.submit(dto, idempotencyKey, {
        consumerName: this.consumerName,
        messageId,
        payloadHash,
      });

      await this.client.send(new DeleteMessageCommand({
        QueueUrl: WAGER_QUEUE_URL,
        ReceiptHandle: receiptHandle,
      }));

      this.logger.log(JSON.stringify({
        event: result.duplicateMessage ? 'sqs_duplicate_acknowledged' : 'sqs_message_processed',
        messageId,
        transactionId: result.transactionId || undefined,
        status: result.status,
      }));
    } catch (error) {
      const permanent = error instanceof BadRequestException || error instanceof UnprocessableEntityException;
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

      if (permanent) {
        await this.client.send(new SendMessageCommand({
          QueueUrl: WAGER_DLQ_URL,
          MessageBody: body,
          MessageGroupId: 'invalid-wager-message',
          MessageDeduplicationId: createHash('sha256').update(messageId).digest('hex'),
        }));
        await this.client.send(new DeleteMessageCommand({
          QueueUrl: WAGER_QUEUE_URL,
          ReceiptHandle: receiptHandle,
        }));
        await this.wagering.recordOperationalCounter('sqs_dlq_messages');
        this.logger.warn(JSON.stringify({
          event: 'sqs_message_sent_to_dlq',
          messageId,
          receiveCount,
        }));
        return;
      }

      const visibility = Math.min(30, Math.max(2, 2 ** Math.min(receiveCount, 5)));
      await this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: WAGER_QUEUE_URL,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibility,
      }));
      await this.wagering.recordOperationalCounter('sqs_retries');
      this.logger.error(JSON.stringify({
        event: 'sqs_message_retry_scheduled',
        messageId,
        receiveCount,
        visibilitySeconds: visibility,
        error: error instanceof Error ? error.message : 'unknown',
      }));
    }
  }
}
