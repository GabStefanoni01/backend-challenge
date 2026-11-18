import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { MoneyInputDto } from '../../wallets/dto/create-wallet.dto';

export enum PublicWagerKind {
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export class CreateWagerTransactionDto {
  @IsString() @Length(1, 128)
  providerId!: string;

  @IsString() @Length(1, 256)
  externalTransactionId!: string;

  @IsString() @Length(1, 128)
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString() @Length(1, 256)
  roundId!: string;

  @IsString() @Length(1, 256)
  gameId!: string;

  @IsEnum(PublicWagerKind)
  kind!: PublicWagerKind;

  @ValidateNested() @Type(() => MoneyInputDto)
  money!: MoneyInputDto;

  @IsOptional() @IsString() @Length(1, 256)
  referenceExternalTransactionId?: string;
}
