import { Injectable, NotFoundException, Optional, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import sharp from 'sharp';
import { aiCanDress, aiCanWear, OPEN_FRONT } from '@vestirse/shared-types';
import { mediaUrl } from '../../../common/mappers';
import { ObjectStorage } from '../../../common/storage';
import { AiSettingsService } from '../../ai-settings/ai-settings.module';
import { CatalogRepository } from '../../catalog/application/catalog.repository';
import { describeBody, describeFit } from './fit-brief';
import { GarmentTransferPort, OutfitFinisherPort, TransferUnavailableError, type TransferResult } from './garment-transfer.port';

export interface ModelPreview {
  imageUrl: string;
  /** false = se acaba de generar (gastó cuota del motor). */
  cached: boolean;
}

/**
 * "Cuerpo similar al mío" con fotos reales: viste con IA la foto de un modelo del
 * catálogo. Cada par modelo × prenda se genera una sola vez y queda publicado en
 * el catálogo: las fotos son de banco con licencia libre, no de clientes.
 */
@Injectable()
export class ModelPreviewService {
  /** Peticiones simultáneas del mismo par comparten una sola generación. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly catalog: CatalogRepository,
    private readonly storage: ObjectStorage,
    private readonly transfer: GarmentTransferPort,
    private readonly aiSettings: AiSettingsService,
    @Optional() private readonly finisher?: OutfitFinisherPort,
  ) {}

  async ensure(bodyModelId: string, garmentId: string): Promise<ModelPreview> {
    const existing = await this.catalog.findPreviewKey(bodyModelId, garmentId);
    if (existing) return { imageUrl: mediaUrl(existing), cached: true };

    const pair = `${bodyModelId}:${garmentId}`;
    let pending = this.inFlight.get(pair);
    if (!pending) {
      pending = this.generate(bodyModelId, garmentId).finally(() => this.inFlight.delete(pair));
      this.inFlight.set(pair, pending);
    }
    return { imageUrl: mediaUrl(await pending), cached: false };
  }

  private async generate(bodyModelId: string, garmentId: string): Promise<string> {
    const [garment, photo, body] = await Promise.all([
      this.catalog.findGarment(garmentId),
      this.catalog.garmentPhoto(garmentId),
      this.catalog.bodyModelPhoto(bodyModelId),
    ]);
    if (!garment || !photo || !body) throw new NotFoundException();
    const imageAi = !!this.finisher?.dressesOutfits;
    // FASHN rellena con piel el escote de un cárdigan abierto; la IA de imagen le pone una camiseta debajo.
    const openFront = (garment.knownLimitations ?? []).includes(OPEN_FRONT);
    if (openFront && !imageAi) throw new UnprocessableEntityException('la IA no puede probar esta prenda abierta sobre un modelo');
    if (!aiCanWear(garment)) throw new UnprocessableEntityException('esta prenda no se puede probar sobre un modelo');
    if (!aiCanDress(body, garment.category)) throw new UnprocessableEntityException('en la foto de este modelo la IA no puede cambiar esa parte');

    const [person, garmentImage] = await Promise.all([this.storage.getBuffer(body.key), this.storage.getBuffer(photo.key)]);
    if (!person || !garmentImage) throw new NotFoundException();

    let result: TransferResult;
    if (imageAi) {
      const dressed = await this.finisher!.finish({
        requestId: `preview-${bodyModelId.slice(0, 8)}-${garmentId.slice(0, 8)}`,
        mode: 'dress',
        person,
        pieces: [{ image: garmentImage, mime: 'image/jpeg', category: garment.category, name: garment.name, delta: 0, openFront }],
      });
      if (!dressed) throw new ServiceUnavailableException('ai-unavailable');
      result = dressed;
    } else {
      try {
        result = await this.transfer.generate({
          requestId: `preview-${bodyModelId.slice(0, 8)}-${garmentId.slice(0, 8)}`,
          person,
          garments: [
            {
              image: garmentImage,
              mime: 'image/jpeg',
              category: garment.category,
              name: garment.name,
              color: garment.color,
              fit: describeFit(null, garment.category, garment.knownLimitations),
              photoType: photo.photoType,
            },
          ],
          bodyBrief: describeBody(),
          credentials: await this.aiSettings.resolve(),
        });
      } catch (err) {
        if (err instanceof TransferUnavailableError) throw new ServiceUnavailableException(err.reason);
        throw err;
      }
    }

    const key = `catalog/bodies/${bodyModelId}/previews/${garmentId}.jpg`;
    await this.storage.put(key, await sharp(result.image).jpeg({ quality: 88 }).toBuffer(), 'image/jpeg');
    await this.catalog.savePreview(bodyModelId, garmentId, key);
    return key;
  }
}
