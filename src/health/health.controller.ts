import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

@Controller('health')
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; dependencies: { postgres: 'ok' } }> {
    try {
      await this.orm.getConnection().execute('SELECT 1');
      return { status: 'ok', dependencies: { postgres: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        dependencies: { postgres: 'unavailable' },
      });
    }
  }
}
