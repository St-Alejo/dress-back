import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { loggerParams } from './common/logging';
import { PrismaModule } from './common/prisma.service';
import { RequesterMiddleware } from './common/requester';
import { StorageModule } from './common/storage';
import { AdminModule } from './modules/admin/admin.module';
import { AiSettingsModule } from './modules/ai-settings/ai-settings.module';
import { validateEnv } from './config/env.schema';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { FitModule } from './modules/fit/fit.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { ProfileModule } from './modules/profile/profile.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { TryOnModule } from './modules/tryon/tryon.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRoot(loggerParams(process.env.NODE_ENV)),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_SECRET'), signOptions: { expiresIn: '7d' } }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: Number(config.get('REDIS_PORT', 6379)),
          username: config.get('REDIS_USERNAME') || undefined,
          password: config.get('REDIS_PASSWORD') || undefined,
          // family 0: resuelve IPv4 e IPv6 (las redes privadas de Railway son IPv6).
          family: 0,
        },
      }),
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    StorageModule,
    MetricsModule,
    AiSettingsModule,
    CatalogModule,
    FitModule,
    TryOnModule,
    PrivacyModule,
    ProfileModule,
    FavoritesModule,
    ReviewsModule,
    AuthModule,
    AdminModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequesterMiddleware).forRoutes('*path');
  }
}
