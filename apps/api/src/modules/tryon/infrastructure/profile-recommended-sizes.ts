import { Injectable } from '@nestjs/common';
import { FitEngine } from '@vestirse/fit-engine';
import type { GarmentItem } from '@vestirse/shared-types';
import { PrismaService } from '../../../common/prisma.service';
import { RecommendedSizes, bodyBrief } from '../application/outfit-finish';

/** Recomienda con las medidas del perfil guardado (con consentimiento). Sin perfil, nada. */
@Injectable()
export class ProfileRecommendedSizes extends RecommendedSizes {
  private readonly engine = new FitEngine();

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async forUser(userId: string | undefined, garments: GarmentItem[]): Promise<Map<string, string>> {
    const sizes = new Map<string, string>();
    if (!userId) return sizes;
    const profile = await this.prisma.bodyProfile.findUnique({ where: { userId } });
    if (!profile) return sizes;
    const measurements = {
      heightCm: profile.heightCm,
      weightKg: profile.weightKg ?? undefined,
      chestCm: profile.chestCm ?? undefined,
      waistCm: profile.waistCm ?? undefined,
      hipCm: profile.hipCm ?? undefined,
      estimatedFromPose: profile.aiFields.length > 0,
    };
    for (const g of garments) {
      if (!g.sizeChart?.length) continue;
      try {
        const rec = this.engine.recommend({ measurements, sizeChart: g.sizeChart, category: g.category, stretch: g.stretch, fitIntent: g.fitIntent });
        if (rec.recommendedSize) sizes.set(g.id, rec.recommendedSize);
      } catch {
        // Tabla sin datos suficientes para esta prenda: sin recomendación, sin exagerar la talla.
      }
    }
    return sizes;
  }

  override async bodyFor(userId: string | undefined): Promise<string> {
    if (!userId) return '';
    const profile = await this.prisma.bodyProfile.findUnique({ where: { userId } });
    return profile ? bodyBrief(profile) : '';
  }
}
