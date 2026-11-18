import { Controller, Get, Param } from '@nestjs/common';
import { WageringService } from './wagering.service';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringController {
  constructor(private readonly wagering: WageringService) {}

  @Get(':externalTransactionId')
  findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.wagering.findByProviderExternalId(providerId, externalTransactionId);
  }
}
