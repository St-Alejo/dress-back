import { Body, Controller, Delete, Get, HttpCode, Injectable, Logger, Module, Patch, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IsBoolean } from 'class-validator';
import { PHOTO_TTL_HOURS } from '@vestirse/shared-types';
import type { Response } from 'express';
import { AuthGuard } from '../../common/guards';
import { PrismaService } from '../../common/prisma.service';
import { AUTH_COOKIE, CurrentRequester, type Requester } from '../../common/requester';
import { ObjectStorage } from '../../common/storage';
import { TryOnSessionRepository } from '../tryon/application/tryon-session.repository';
import { TryOnSessionsPersistenceModule } from '../tryon/tryon-persistence.module';

/**
 * Política de retención como código (sección 8). No es una nota legal:
 * aquí se borran objetos de verdad.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly sessions: TryOnSessionRepository,
    private readonly storage: ObjectStorage,
    private readonly prisma: PrismaService,
  ) {}

  /** Borra fotos (y resultados no guardados) vencidas. Corre cada 10 minutos. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async purgeExpired(now = new Date()): Promise<number> {
    let purged = 0;
    for (;;) {
      const batch = await this.sessions.findWithExpiredPhotos(now, 200);
      if (batch.length === 0) break;
      const keys = batch.flatMap((s) => s.purgePhoto());
      await this.storage.deleteMany(keys);
      for (const s of batch) await this.sessions.save(s);
      purged += batch.length;
    }
    if (purged) this.logger.log(`retención: ${purged} sesiones con foto vencida purgadas`);
    return purged;
  }

  /** Borrado de cuenta = borrado real de fotos y resultados en el almacenamiento (sección 8.5). */
  async deleteAccount(userId: string) {
    const sessions = await this.sessions.findByUser(userId);
    const profile = await this.prisma.bodyProfile.findUnique({ where: { userId }, select: { photoKey: true } });
    const favorites = await this.prisma.favoriteOutfit.findMany({ where: { userId }, select: { imageKey: true } });
    const keys = [
      ...sessions.flatMap((s) => [s.snapshot.photoKey, s.snapshot.resultKey]),
      profile?.photoKey,
      ...favorites.map((f) => f.imageKey),
    ].filter((k): k is string => !!k);
    await this.storage.deleteMany(keys);
    await this.prisma.user.delete({ where: { id: userId } });
    return { deletedObjects: keys.length, deletedSessions: sessions.length };
  }
}

class ConsentDto {
  @IsBoolean() retrainingConsent: boolean;
}

@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly retention: RetentionService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Datos que el checklist de privacidad muestra antes de la primera subida. */
  @Get('policy')
  policy() {
    return {
      photoTtlHours: Number(this.config.get('PHOTO_TTL_HOURS', PHOTO_TTL_HOURS)),
      liveCameraLeavesDevice: false,
      usedForTrainingByDefault: false,
    };
  }

  /** Consentimiento de reentrenamiento: separado, explícito y revocable. */
  @UseGuards(AuthGuard)
  @Patch('consent')
  async consent(@Body() dto: ConsentDto, @CurrentRequester() r: Requester) {
    const user = await this.prisma.user.update({ where: { id: r.userId }, data: { retrainingConsent: dto.retrainingConsent } });
    return { retrainingConsent: user.retrainingConsent };
  }

  @UseGuards(AuthGuard)
  @Delete('account')
  @HttpCode(200)
  async deleteAccount(@CurrentRequester() r: Requester, @Res({ passthrough: true }) res: Response) {
    const result = await this.retention.deleteAccount(r.userId!);
    res.clearCookie(AUTH_COOKIE);
    return result;
  }
}

@Module({
  imports: [TryOnSessionsPersistenceModule],
  controllers: [PrivacyController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class PrivacyModule {}
