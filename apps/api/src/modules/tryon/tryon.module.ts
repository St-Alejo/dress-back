import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { GarmentTransferPort, OutfitFinisherPort } from './application/garment-transfer.port';
import { RecommendedSizes } from './application/outfit-finish';
import { ModelPreviewService } from './application/model-preview.service';
import { GENERATION_QUEUE, TryOnService } from './application/tryon.service';
import { AiWorkerAdapter } from './infrastructure/ai-worker.adapter';
import { GenerationReaper } from './infrastructure/generation-reaper';
import { GenerationProcessor } from './infrastructure/generation.processor';
import { WorkerOutfitFinisher } from './infrastructure/outfit-finisher.adapter';
import { ProfileRecommendedSizes } from './infrastructure/profile-recommended-sizes';
import { TryOnGateway } from './infrastructure/tryon.gateway';
import { ModelPreviewController } from './interface/model-preview.controller';
import { TryOnController } from './interface/tryon.controller';
import { TryOnSessionsPersistenceModule } from './tryon-persistence.module';

@Module({
  imports: [CatalogModule, TryOnSessionsPersistenceModule, BullModule.registerQueue({ name: GENERATION_QUEUE })],
  controllers: [TryOnController, ModelPreviewController],
  providers: [
    TryOnService,
    ModelPreviewService,
    TryOnGateway,
    GenerationProcessor,
    GenerationReaper,
    { provide: GarmentTransferPort, useClass: AiWorkerAdapter },
    { provide: OutfitFinisherPort, useClass: WorkerOutfitFinisher },
    { provide: RecommendedSizes, useClass: ProfileRecommendedSizes },
  ],
  exports: [OutfitFinisherPort, RecommendedSizes],
})
export class TryOnModule {}
