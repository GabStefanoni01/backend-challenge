import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module';
import { OutboxPublisher } from './outbox.publisher';
import { WagerConsumer } from './wager.consumer';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({
  imports: [WageringModule],
  providers: [OutboxPublisher, WagerConsumer, PendingReferenceWorker],
})
export class MessagingModule {}
