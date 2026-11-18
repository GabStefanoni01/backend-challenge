import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  create(@Body() body: CreateWalletDto) {
    return this.wallets.create(body);
  }

  @Get(':walletId')
  findById(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.wallets.findById(walletId);
  }
}
