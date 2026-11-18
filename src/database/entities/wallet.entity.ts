import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', length: 128 })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  /** PostgreSQL NUMERIC is hydrated as a string to preserve exact precision. */
  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'Date' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'Date' })
  updatedAt!: Date;
}
