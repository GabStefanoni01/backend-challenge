import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WageringService } from '../wagering/wagering.service';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private stopping = false;
  private loop?: Promise<void>;

  constructor(private readonly wagering: WageringService) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.wagering.processPendingReferences();
        if (result.resolved > 0 || result.stillPending > 0) {
          this.logger.log(JSON.stringify({
            event: 'pending_references_scanned',
            resolved: result.resolved,
            rescheduled: result.stillPending,
          }));
        }
      } catch (error) {
        this.logger.error(JSON.stringify({
          event: 'pending_reference_worker_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
