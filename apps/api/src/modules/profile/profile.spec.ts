import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import type { BodyEstimate } from '@vestirse/shared-types';
import { PRIVATE_PREFIX } from '../../common/storage';
import { MemoryStorage } from '../../testing/memory';
import { mergeEstimate, ProfileService, type ProfileRow } from './profile.module';

const EMPTY = { chestCm: null, waistCm: null, hipCm: null, shoulderCm: null, aiFields: [] as string[] };
const ESTIMATE: BodyEstimate = { checked: true, usable: true, measurements: { chestCm: 96, waistCm: 82, hipCm: 100 }, confidence: 'medium' };

describe('mergeEstimate', () => {
  it('rellena con la IA lo que la persona no escribió y lo marca como estimado', () => {
    const { update, aiFields } = mergeEstimate(EMPTY, ESTIMATE);
    expect(update).toEqual({ chestCm: 96, waistCm: 82, hipCm: 100 });
    expect(aiFields.sort()).toEqual(['chestCm', 'hipCm', 'waistCm']);
  });

  it('nunca pisa una medida tomada por la persona, pero sí una estimada antes', () => {
    const { update } = mergeEstimate({ ...EMPTY, chestCm: 101, waistCm: 70, aiFields: ['waistCm'] }, ESTIMATE);
    expect(update).toEqual({ waistCm: 82, hipCm: 100 });
  });

  it('una foto no utilizable no cambia nada', () => {
    expect(mergeEstimate(EMPTY, { checked: true, usable: false, reason: 'not-frontal' }).update).toEqual({});
  });
});

/** Prisma en memoria, solo lo que usa el servicio. */
function fakePrisma() {
  const rows = new Map<string, ProfileRow>();
  const bodyProfile = {
    findUnique: async ({ where }: { where: { userId: string } }) => rows.get(where.userId) ?? null,
    upsert: async ({ where, create, update }: { where: { userId: string }; create: Partial<ProfileRow>; update: Partial<ProfileRow> }) => {
      const prev = rows.get(where.userId);
      const base: ProfileRow = prev ?? { ...{ weightKg: null, photoKey: null, ...EMPTY }, ...(create as ProfileRow) };
      const row = { ...base, ...(prev ? update : {}), updatedAt: new Date() } as ProfileRow;
      rows.set(where.userId, row);
      return row;
    },
    update: async ({ where, data }: { where: { userId: string }; data: Partial<ProfileRow> }) => {
      const row = { ...rows.get(where.userId)!, ...data, updatedAt: new Date() };
      rows.set(where.userId, row);
      return row;
    },
    delete: async ({ where }: { where: { userId: string } }) => rows.delete(where.userId),
  };
  return { bodyProfile, rows };
}

async function upload() {
  const buffer = await sharp({ create: { width: 30, height: 60, channels: 3, background: '#777' } }).png().toBuffer();
  return { buffer, mimetype: 'image/png', size: buffer.length };
}

describe('ProfileService', () => {
  function setup() {
    const prisma = fakePrisma();
    const storage = new MemoryStorage();
    const worker = { inspectPhoto: jest.fn().mockResolvedValue({ checked: true, ok: true, reason: null }), estimateBody: jest.fn().mockResolvedValue(ESTIMATE) };
    return { service: new ProfileService(prisma as never, storage, worker as never), prisma, storage, worker };
  }

  it('sin perfil (sin consentimiento) no acepta foto', async () => {
    const { service, storage } = setup();
    await expect(service.setPhoto('u1', await upload())).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.objects.size).toBe(0);
  });

  it('la foto se guarda fuera del prefijo de 24 h, sustituye a la anterior y la IA completa medidas', async () => {
    const { service, storage, worker } = setup();
    await service.save('u1', { consent: true, heightCm: 170, chestCm: 99 });
    const first = await service.setPhoto('u1', await upload());
    const second = await service.setPhoto('u1', await upload());
    const keys = [...storage.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(PRIVATE_PREFIX)).toBe(false);
    expect(worker.estimateBody).toHaveBeenCalledWith(expect.any(Buffer), 170);
    expect(first.profile).toMatchObject({ chestCm: 99, waistCm: 82, hipCm: 100, hasPhoto: true });
    expect(second.profile.aiFields.sort()).toEqual(['hipCm', 'waistCm']);
  });

  it('escribir una medida la saca de las estimadas', async () => {
    const { service } = setup();
    await service.save('u1', { consent: true, heightCm: 170 });
    await service.setPhoto('u1', await upload());
    const edited = await service.save('u1', { consent: true, heightCm: 170, waistCm: 79, chestCm: 96 });
    expect(edited.waistCm).toBe(79);
    expect(edited.aiFields.sort()).toEqual(['chestCm', 'hipCm']);
  });

  it('retirar el consentimiento borra la fila y la foto de verdad', async () => {
    const { service, storage, prisma } = setup();
    await service.save('u1', { consent: true, heightCm: 170 });
    await service.setPhoto('u1', await upload());
    expect(await service.remove('u1')).toEqual({ deleted: true });
    expect(storage.objects.size).toBe(0);
    expect(prisma.rows.size).toBe(0);
  });
});
