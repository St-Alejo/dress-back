import { BadRequestException, NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import type { BodyEstimate } from '@vestirse/shared-types';
import { MemoryStorage } from '../../testing/memory';
import { FitService } from './fit.module';

const ESTIMATE: BodyEstimate = { checked: true, usable: true, reason: null, measurements: { chestCm: 96 }, confidence: 'medium' };
const requester = { sid: 'sid-1' } as never;

async function jpeg() {
  return sharp({ create: { width: 40, height: 60, channels: 3, background: '#888' } }).jpeg().toBuffer();
}

function setup(session?: { photoKey?: string }) {
  const worker = { estimateBody: jest.fn().mockResolvedValue(ESTIMATE) };
  const sessions = { findOwned: jest.fn().mockResolvedValue(session ?? null), save: jest.fn() };
  const storage = new MemoryStorage();
  const service = new FitService({} as never, {} as never, sessions as never, {} as never, worker as never, storage);
  return { service, worker, storage };
}

describe('FitService.measure', () => {
  it('limpia la foto subida y pasa la altura al worker sin guardar nada', async () => {
    const { service, worker, storage } = setup();
    const photo = await jpeg();
    const res = await service.measure({ buffer: photo, mimetype: 'image/jpeg', size: photo.length }, { heightCm: 172 }, requester);
    expect(res).toEqual(ESTIMATE);
    expect(worker.estimateBody).toHaveBeenCalledWith(expect.any(Buffer), 172);
    expect(storage.objects.size).toBe(0);
  });

  it('puede medir con la foto ya subida a la sesión', async () => {
    const { service, worker, storage } = setup({ photoKey: 'uploads/s1/photo.jpg' });
    const photo = await jpeg();
    await storage.put('uploads/s1/photo.jpg', photo);
    await service.measure(undefined, { heightCm: 160, sessionId: '4f0c3c1e-1111-4222-8333-444455556666' }, requester);
    expect(worker.estimateBody).toHaveBeenCalledWith(photo, 160);
  });

  it('sin foto ni sesión válida no llama a la IA', async () => {
    const { service, worker } = setup();
    await expect(service.measure(undefined, { heightCm: 170 }, requester)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.measure(undefined, { heightCm: 170, sessionId: '4f0c3c1e-1111-4222-8333-444455556666' }, requester),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(worker.estimateBody).not.toHaveBeenCalled();
  });
});
