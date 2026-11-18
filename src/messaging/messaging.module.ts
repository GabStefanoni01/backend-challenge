import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module';
import { OutboxPublisher } from './outbox.publisher';
import { WagerConsumer } from './wager.consumer';

@Module({
  imports: [WageringModule],
  providers: [OutboxPublisher, WagerConsumer],
})
export class MessagingModule {}
