import { Module } from '@nestjs/common';
import { ProviderWageringController } from './providers.controller';
import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';

@Module({
  controllers: [WageringController, ProviderWageringController],
  providers: [WageringService],
})
export class WageringModule {}
