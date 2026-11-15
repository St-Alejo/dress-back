import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { GarmentItem } from '@vestirse/shared-types';
import type { PrismaService } from '../../common/prisma.service';
import { MemorySessions, MemoryStorage } from '../../testing/memory';
import type { CatalogRepository } from '../catalog/application/catalog.repository';
import type { RecommendedSizes } from '../tryon/application/outfit-finish';
import { TryOnSession } from '../tryon/domain/tryon-session.entity';
import { FavoritesService, toDto, type FavoriteRow } from './favorites.module';

const GARMENTS: Record<string, GarmentItem> = {
  shirt: { id: 'shirt', name: 'Camisa Oxford', category: 'top' } as GarmentItem,
  shoes: { id: 'shoes', name: 'Tenis blancos', category: 'footwear' } as GarmentItem,
};

function setup() {
  const rows: FavoriteRow[] = [];
  const prisma = {
    favoriteOutfit: {
      findMany: async ({ where }: { where: { userId: string } }) => rows.filter((r) => r.userId === where.userId).reverse(),
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
      create: async ({ data }: { data: Omit<FavoriteRow, 'createdAt'> }) => {
        const row = { ...data, createdAt: new Date('2026-11-15T12:00:00Z') };
        rows.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => rows.splice(rows.findIndex((r) => r.id === where.id), 1),
    },
  } as unknown as PrismaService;
  const storage = new MemoryStorage();
  const sessions = new MemorySessions();
  const catalog = { findGarment: async (id: string) => GARMENTS[id] ?? null } as unknown as CatalogRepository;
  const sizes = { forUser: async () => new Map([['shirt', 'M']]) } as unknown as RecommendedSizes;
  const service = new FavoritesService(prisma, storage, catalog, sessions, sizes);
  return { rows, storage, sessions, service };
}

async function doneSession(env: ReturnType<typeof setup>, done = true) {
  const s = TryOnSession.start({
    id: '11111111-1111-4111-8111-111111111111',
    garmentId: 'shirt',
    mode: 'photorealistic',
    outfit: [{ garmentId: 'shirt', size: 'L' }, { garmentId: 'shoes', size: '42' }],
    requester: { sid: 'sid', userId: 'u1' },
    now: new Date(),
  });
  s.attachPhoto(new Date(), 24);
  s.requestGeneration();
  if (done) {
    s.complete();
    await env.storage.put(s.resultKey!, Buffer.from('imagen-ia'));
  }
  await env.sessions.create(s);
  return s;
}

describe('FavoritesService', () => {
  const me = { sid: 'sid', userId: 'u1' };

  it('guarda el resultado del probador con las tallas probadas y recomendadas, y copia la imagen fuera del TTL', async () => {
    const env = setup();
    const s = await doneSession(env);
    const fav = await env.service.saveFromSession('u1', { sessionId: s.id, wearer: ' Ella ' }, me);

    expect(fav.title).toBe('Camisa Oxford + Tenis blancos');
    expect(fav.wearer).toBe('Ella');
    expect(fav.items.map((i) => [i.garment.name, i.size, i.recommendedSize])).toEqual([
      ['Camisa Oxford', 'L', 'M'],
      ['Tenis blancos', '42', undefined],
    ]);
    const key = env.rows[0]!.imageKey;
    expect(key).toBe(`saved/favorites/u1/${fav.id}.png`);
    expect(key.startsWith('uploads/')).toBe(false);
    expect(env.storage.objects.get(key)?.toString()).toBe('imagen-ia');
    expect(fav.imageUrl).toBe(`/api/favorites/${fav.id}/image`);
  });

  it('no guarda una prueba sin resultado ni la de otra persona', async () => {
    const env = setup();
    const s = await doneSession(env, false);
    await expect(env.service.saveFromSession('u1', { sessionId: s.id }, me)).rejects.toBeInstanceOf(BadRequestException);
    await expect(env.service.saveFromSession('u2', { sessionId: s.id }, { sid: 'otro', userId: 'u2' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lista solo los de la cuenta y borrar elimina la imagen de verdad', async () => {
    const env = setup();
    const mine = await env.service.create('u1', { title: 'Oficina', items: [{ garmentId: 'shirt', size: 'M' }], image: Buffer.from('a') });
    await env.service.create('u2', { title: 'Ajeno', items: [], image: Buffer.from('b') });

    const list = await env.service.list('u1');
    expect(list.map((f) => f.title)).toEqual(['Oficina']);
    await expect(env.service.image('u2', mine.id)).rejects.toBeInstanceOf(NotFoundException);

    expect(await env.service.remove('u2', mine.id)).toEqual({ deleted: false });
    expect(await env.service.remove('u1', mine.id)).toEqual({ deleted: true });
    expect(env.storage.objects.has(mine.imageKey)).toBe(false);
    expect(await env.service.list('u1')).toEqual([]);
  });

  it('una prenda que ya no está en el catálogo no rompe el favorito', () => {
    const row: FavoriteRow = {
      id: 'f1', userId: 'u1', title: 'T', wearer: null, bodyModelId: null, imageKey: 'k', note: 'nota',
      items: [{ garmentId: 'shirt', size: 'M' }, { garmentId: 'borrada', size: 'S' }], createdAt: new Date(0),
    };
    const dto = toDto(row, new Map([['shirt', GARMENTS.shirt!]]));
    expect(dto.items).toHaveLength(1);
    expect(dto.note).toBe('nota');
    expect(dto.wearer).toBeUndefined();
  });
});
