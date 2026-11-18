import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  create(@Body() body: CreateWalletDto) {
    return this.wallets.create(body);
  }

  @Get(':walletId/ledger')
  getLedger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return this.wallets.getLedger(walletId, cursor, parsedLimit);
  }

  @Post(':walletId/reconciliation')
  reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.wallets.reconcile(walletId);
  }

  @Get(':walletId')
  findById(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.wallets.findById(walletId);
  }
}
