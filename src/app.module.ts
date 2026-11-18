import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        clientUrl: config.get<string>('DATABASE_URL'),
        entities: [],
        migrations: {
          path: './dist/database/migrations',
          pathTs: './src/database/migrations',
          transactional: true,
          allOrNothing: true,
        },
        allowGlobalContext: false,
      }),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
