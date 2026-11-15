import { Injectable } from '@nestjs/common';
import type { FitRecommendation, OutfitItem } from '@vestirse/shared-types';
import { fromDbMode, toDbMode } from '../../../common/mappers';
import { PrismaService } from '../../../common/prisma.service';
import type { Requester } from '../../../common/requester';
import type { Prisma, TryOnSession as Row } from '../../../generated/prisma/client';
import { TryOnSessionRepository } from '../application/tryon-session.repository';
import { TryOnSession } from '../domain/tryon-session.entity';

const toEntity = (r: Row) =>
  TryOnSession.restore({
    id: r.id,
    ownerSid: r.ownerSid,
    userId: r.userId ?? undefined,
    garmentId: r.garmentId,
    mode: fromDbMode(r.mode),
    bodyModelId: r.bodyModelId ?? undefined,
    photoKey: r.photoKey ?? undefined,
    photoExpiresAt: r.photoExpiresAt ?? undefined,
    resultKey: r.resultKey ?? undefined,
    resultSaved: r.resultSaved,
    generationStatus: r.generationStatus,
    failureReason: r.failureReason ?? undefined,
    statusChangedAt: r.statusChangedAt,
    fitRecommendation: (r.fitRecommendation as unknown as FitRecommendation) ?? undefined,
    outfit: (r.outfit as unknown as OutfitItem[] | null) ?? undefined,
    createdAt: r.createdAt,
  });

function toData(s: TryOnSession) {
  const p = s.snapshot;
  return {
    ownerSid: p.ownerSid,
    userId: p.userId ?? null,
    garmentId: p.garmentId,
    mode: toDbMode(p.mode),
    bodyModelId: p.bodyModelId ?? null,
    photoKey: p.photoKey ?? null,
    photoExpiresAt: p.photoExpiresAt ?? null,
    resultKey: p.resultKey ?? null,
    resultSaved: p.resultSaved,
    generationStatus: p.generationStatus,
    failureReason: p.failureReason ?? null,
    statusChangedAt: p.statusChangedAt,
    fitRecommendation: (p.fitRecommendation as unknown as Prisma.InputJsonValue) ?? undefined,
    outfit: (p.outfit as unknown as Prisma.InputJsonValue) ?? undefined,
  };
}

const ownedBy = (r: Requester): Prisma.TryOnSessionWhereInput => ({
  OR: [{ ownerSid: r.sid }, ...(r.userId ? [{ userId: r.userId }] : [])],
});

@Injectable()
export class PrismaTryOnSessionRepository extends TryOnSessionRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(s: TryOnSession) {
    await this.prisma.tryOnSession.create({ data: { id: s.id, createdAt: s.snapshot.createdAt, ...toData(s) } });
  }

  async save(s: TryOnSession) {
    await this.prisma.tryOnSession.update({ where: { id: s.id }, data: toData(s) });
  }

  async findById(id: string) {
    const row = await this.prisma.tryOnSession.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findOwned(id: string, r: Requester) {
    const row = await this.prisma.tryOnSession.findFirst({ where: { id, ...ownedBy(r) } });
    return row ? toEntity(row) : null;
  }

  async listOwned(r: Requester, limit: number) {
    const rows = await this.prisma.tryOnSession.findMany({ where: ownedBy(r), orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(toEntity);
  }

  async findWithExpiredPhotos(now: Date, limit: number) {
    const rows = await this.prisma.tryOnSession.findMany({ where: { photoExpiresAt: { lte: now } }, take: limit });
    return rows.map(toEntity);
  }

  async findStuck(changedBefore: Date, limit: number) {
    const rows = await this.prisma.tryOnSession.findMany({
      where: { generationStatus: { in: ['queued', 'processing'] }, statusChangedAt: { lt: changedBefore } },
      take: limit,
    });
    return rows.map(toEntity);
  }

  async findByUser(userId: string) {
    const rows = await this.prisma.tryOnSession.findMany({ where: { userId } });
    return rows.map(toEntity);
  }
}
