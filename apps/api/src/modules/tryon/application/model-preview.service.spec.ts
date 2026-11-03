import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import sharp from 'sharp';
import type { GarmentItem } from '@vestirse/shared-types';
import { MemoryStorage } from '../../../testing/memory';
import type { AiSettingsService } from '../../ai-settings/ai-settings.module';
import type { CatalogRepository } from '../../catalog/application/catalog.repository';
import { GarmentTransferPort, TransferUnavailableError, type TransferRequest, type TransferResult } from './garment-transfer.port';
import { ModelPreviewService } from './model-preview.service';

class FakeTransfer extends GarmentTransferPort {
  calls: TransferRequest[] = [];
  next: () => Promise<TransferResult>;
  async generate(req: TransferRequest) {
    this.calls.push(req);
    return this.next();
  }
}

async function setup(category: GarmentItem['category'] = 'dress', onePiece = false, handsInPockets = false) {
  const storage = new MemoryStorage();
  storage.objects.set('catalog/bodies/b1/photo.jpg', Buffer.from('person'));
  storage.objects.set('catalog/garments/g1/photo.jpg', Buffer.from('garment'));
  const png = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#336699' } }).png().toBuffer();
  const transfer = new FakeTransfer();
  transfer.next = async () => ({ image: png, engine: 'hf-fashn', durationMs: 5 });
  const previews = new Map<string, string>();
  const catalog = {
    findGarment: async () => ({ id: 'g1', name: 'Vestido', category, color: '#ff0000' }) as GarmentItem,
    garmentPhoto: async () => ({ key: 'catalog/garments/g1/photo.jpg', photoType: 'flat-lay' }),
    bodyModelPhoto: async () => ({ key: 'catalog/bodies/b1/photo.jpg', onePiece, handsInPockets }),
    findPreviewKey: async (b: string, g: string) => previews.get(`${b}:${g}`) ?? null,
    savePreview: async (b: string, g: string, key: string) => void previews.set(`${b}:${g}`, key),
  } as unknown as CatalogRepository;
  const aiSettings = { resolve: async () => ({ provider: 'hf-chain' }) } as unknown as AiSettingsService;
  return { service: new ModelPreviewService(catalog, storage, transfer, aiSettings), storage, transfer, previews };
}

describe('ModelPreviewService', () => {
  it('genera la prueba una sola vez y después la sirve del catálogo', async () => {
    const env = await setup();
    const first = await env.service.ensure('b1', 'g1');
    const second = await env.service.ensure('b1', 'g1');

    expect(first).toEqual({ imageUrl: '/api/media/catalog/bodies/b1/previews/g1.jpg', cached: false });
    expect(second).toEqual({ ...first, cached: true });
    expect(env.transfer.calls).toHaveLength(1);
    expect(env.transfer.calls[0].garments[0]).toMatchObject({ category: 'dress', photoType: 'flat-lay', mime: 'image/jpeg' });
    expect((await sharp(env.storage.objects.get('catalog/bodies/b1/previews/g1.jpg')!).metadata()).format).toBe('jpeg');
  });

  it('dos peticiones simultáneas del mismo par comparten una generación', async () => {
    const env = await setup();
    await Promise.all([env.service.ensure('b1', 'g1'), env.service.ensure('b1', 'g1')]);
    expect(env.transfer.calls).toHaveLength(1);
  });

  it('sin cuota en el motor responde 503 y no guarda nada', async () => {
    const env = await setup();
    env.transfer.next = async () => {
      throw new TransferUnavailableError('rate-limited', true);
    };
    await expect(env.service.ensure('b1', 'g1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(env.previews.size).toBe(0);
  });

  it('rechaza calzado y accesorios: ningún motor los pone sobre una persona', async () => {
    const env = await setup('footwear');
    await expect(env.service.ensure('b1', 'g1')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(env.transfer.calls).toHaveLength(0);
  });

  it('sobre un modelo con vestido no prueba partes de arriba ni de abajo (saldría una túnica)', async () => {
    for (const category of ['top', 'bottom'] as const) {
      const env = await setup(category, true);
      await expect(env.service.ensure('b1', 'g1')).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(env.transfer.calls).toHaveLength(0);
    }
    const jacket = await setup('outerwear', true);
    await expect(jacket.service.ensure('b1', 'g1')).resolves.toMatchObject({ cached: false });
  });

  it('con las manos en los bolsillos no cambia la parte de abajo, pero sí la de arriba', async () => {
    const skirt = await setup('bottom', false, true);
    await expect(skirt.service.ensure('b1', 'g1')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(skirt.transfer.calls).toHaveLength(0);
    const shirt = await setup('top', false, true);
    await expect(shirt.service.ensure('b1', 'g1')).resolves.toMatchObject({ cached: false });
  });
});
