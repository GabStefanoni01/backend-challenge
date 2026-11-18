import { Type } from 'class-transformer';
import { IsString, Length, Matches, ValidateNested } from 'class-validator';

export class MoneyInputDto {
  @IsString()
  @Matches(/^(0|[1-9]\\d*)\\.\\d{2}$/, { message: 'amount must be a non-negative decimal string with two fractional digits' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter uppercase ISO code' })
  currency!: string;
}

export class CreateWalletDto {
  @IsString()
  @Length(1, 128)
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyInputDto)
  initialBalance!: MoneyInputDto;
}
