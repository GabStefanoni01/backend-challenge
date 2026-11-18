import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreateWagerTransactionDto } from './dto/create-wager-transaction.dto';
import { WageringService } from './wagering.service';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() body: CreateWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.wagering.submit(body, idempotencyKey ?? '');
    if (result.status === 'PENDING_REFERENCE') response.status(HttpStatus.ACCEPTED);
    else if (result.status === 'REJECTED') response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    return result;
  }

  @Get(':transactionId')
  findById(@Param('transactionId') transactionId: string) {
    return this.wagering.findById(transactionId);
  }
}
