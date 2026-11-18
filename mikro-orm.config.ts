import { defineConfig } from '@mikro-orm/postgresql';
import { WalletEntity } from './src/database/entities/wallet.entity';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  entities: [WalletEntity],
  migrations: {
    path: './dist/database/migrations',
    pathTs: './src/database/migrations',
    transactional: true,
    allOrNothing: true,
  },
});
