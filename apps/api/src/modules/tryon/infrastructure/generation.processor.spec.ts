import type { Job } from 'bullmq';
import type { GarmentItem } from '@vestirse/shared-types';
import { MemorySessions, MemoryStorage } from '../../../testing/memory';
import type { AiSettingsService } from '../../ai-settings/ai-settings.module';
import type { CatalogRepository } from '../../catalog/application/catalog.repository';
import type { MetricsService } from '../../metrics/metrics.module';
import { GarmentTransferPort, TransferUnavailableError, type TransferRequest, type TransferResult } from '../application/garment-transfer.port';
import type { GenerationJob } from '../application/tryon.service';
import { TryOnSession } from '../domain/tryon-session.entity';
import { GenerationProcessor } from './generation.processor';
import type { TryOnGateway } from './tryon.gateway';

const PHOTO = Buffer.from('jpeg');

class FakeTransfer extends GarmentTransferPort {
  calls: TransferRequest[] = [];
  next: () => Promise<TransferResult> = async () => ({ image: Buffer.from('png'), engine: 'mock', durationMs: 5 });
  async generate(req: TransferRequest) {
    this.calls.push(req);
    return this.next();
  }
}

const garment = { id: 'g1', name: 'Camisa', category: 'top', color: 'white' } as GarmentItem;

function setup() {
  const sessions = new MemorySessions();
  const storage = new MemoryStorage();
  const transfer = new FakeTransfer();
  const emit = jest.fn();
  const record = jest.fn();
  const catalog = {
    findGarment: async () => garment,
    garmentPhoto: async () => ({ key: 'catalog/garments/g1/photo.jpg', photoType: 'model' }),
  } as unknown as CatalogRepository;
  const aiSettings = { resolve: async () => ({ provider: 'mock' as const }) } as AiSettingsService;
  const processor = new GenerationProcessor(
    sessions,
    catalog,
    storage,
    transfer,
    aiSettings,
    { emit } as unknown as TryOnGateway,
    { record } as unknown as MetricsService,
  );
  storage.objects.set('catalog/garments/g1/photo.jpg', PHOTO);
  return { sessions, storage, transfer, emit, record, processor };
}

async function queuedSession(env: ReturnType<typeof setup>, withPhoto = true) {
  const s = TryOnSession.start({ id: 's1', garmentId: 'g1', mode: 'photorealistic', requester: { sid: 'sid' }, now: new Date() });
  s.attachPhoto(new Date(), 24);
  s.requestGeneration();
  if (withPhoto) await env.storage.put(s.photoKey!, Buffer.from('jpeg'));
  else s.purgePhoto();
  await env.sessions.create(s);
  return s;
}

/** Otra sesión ya terminada, con su foto y su resultado guardados. */
async function finishedSession(env: ReturnType<typeof setup>, args: { id: string; sid?: string; garmentId?: string; photo?: string }) {
  const s = TryOnSession.start({ id: args.id, garmentId: args.garmentId ?? 'g1', mode: 'photorealistic', requester: { sid: args.sid ?? 'sid' }, now: new Date() });
  s.attachPhoto(new Date(), 24);
  s.requestGeneration();
  s.complete();
  await env.storage.put(s.photoKey!, Buffer.from(args.photo ?? 'jpeg'));
  await env.storage.put(s.resultKey!, Buffer.from('anterior'));
  await env.sessions.create(s);
  return s;
}

const job = (attemptsMade = 0, attempts = 3) => ({ data: { sessionId: 's1' }, attemptsMade, opts: { attempts } }) as Job<GenerationJob>;

describe('GenerationProcessor', () => {
  it('genera con el contrato completo y guarda el resultado', async () => {
    const env = setup();
    await queuedSession(env);
    await env.processor.process(job());

    const req = env.transfer.calls[0];
    expect(req.garments).toEqual([expect.objectContaining({ category: 'top', name: 'Camisa', mime: 'image/jpeg', photoType: 'model' })]);
    expect(req.credentials.provider).toBe('mock');
    expect(req.requestId).toBe('s1-1');
    expect(req.bodyBrief).not.toMatch(/\d/);
    const s = (await env.sessions.findById('s1'))!;
    expect(s.status).toBe('done');
    expect(env.storage.objects.get(s.resultKey!)).toEqual(Buffer.from('png'));
    expect(env.emit).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'done' }));
  });

  it('reutiliza el resultado si la misma persona ya probó esa prenda con la misma foto', async () => {
    const env = setup();
    await finishedSession(env, { id: 's0' });
    await queuedSession(env);
    await env.processor.process(job());

    expect(env.transfer.calls).toHaveLength(0);
    const s = (await env.sessions.findById('s1'))!;
    expect(s.status).toBe('done');
    expect(env.storage.objects.get(s.resultKey!)).toEqual(Buffer.from('anterior'));
  });

  it.each([
    ['de otra persona', { sid: 'otra' }],
    ['de otra prenda', { garmentId: 'g2' }],
    ['con otra foto', { photo: 'distinta' }],
  ])('no reutiliza un resultado %s', async (_caso, other) => {
    const env = setup();
    await finishedSession(env, { id: 's0', ...other });
    await queuedSession(env);
    await env.processor.process(job());
    expect(env.transfer.calls).toHaveLength(1);
  });

  it('volver a generar en la misma sesión pide una imagen nueva al motor', async () => {
    const env = setup();
    await finishedSession(env, { id: 's0' });
    const s = await queuedSession(env);
    s.complete();
    s.requestGeneration();
    await env.processor.process(job());
    expect(env.transfer.calls).toHaveLength(1);
  });

  it('sin foto la sesión termina en failed en vez de quedar en cola', async () => {
    const env = setup();
    const s = await queuedSession(env, false);
    expect(s.photoKey).toBeUndefined();
    await env.processor.process(job());
    expect((await env.sessions.findById('s1'))!.toDto()).toMatchObject({ generationStatus: 'failed', failureReason: 'no-photo' });
  });

  it('un fallo transitorio se relanza para que BullMQ reintente', async () => {
    const env = setup();
    await queuedSession(env);
    env.transfer.next = () => Promise.reject(new TransferUnavailableError('timeout', true));
    await expect(env.processor.process(job(0))).rejects.toBeInstanceOf(TransferUnavailableError);
    expect((await env.sessions.findById('s1'))!.status).toBe('processing');
  });

  it('en el último intento el fallo transitorio pasa a fallback', async () => {
    const env = setup();
    await queuedSession(env);
    env.transfer.next = () => Promise.reject(new TransferUnavailableError('timeout', true));
    await env.processor.process(job(2));
    expect((await env.sessions.findById('s1'))!.toDto()).toMatchObject({ generationStatus: 'fallback', failureReason: 'timeout' });
    expect(env.record).toHaveBeenCalledWith('generation-failed', expect.objectContaining({ reason: 'timeout' }));
  });

  it('la cuota agotada da fallback inmediato: reintentar en segundos no la devuelve', async () => {
    const env = setup();
    await queuedSession(env);
    env.transfer.next = () => Promise.reject(new TransferUnavailableError('rate-limited', true));
    await env.processor.process(job(0));
    expect((await env.sessions.findById('s1'))!.toDto()).toMatchObject({ generationStatus: 'fallback', failureReason: 'rate-limited' });
  });

  it('un fallo definitivo del proveedor da fallback inmediato, sin reintentos', async () => {
    const env = setup();
    await queuedSession(env);
    env.transfer.next = () => Promise.reject(new TransferUnavailableError('not-configured', false));
    await env.processor.process(job(0));
    expect((await env.sessions.findById('s1'))!.status).toBe('fallback');
  });

  it('descarta el trabajo si la sesión ya no está en curso (p. ej. la rescató el reaper)', async () => {
    const env = setup();
    const s = await queuedSession(env);
    s.fail('stuck');
    await env.processor.process(job());
    expect(env.transfer.calls).toHaveLength(0);
    expect((await env.sessions.findById('s1'))!.status).toBe('failed');
  });

  it('si la persona borra la foto durante la generación, el resultado se descarta', async () => {
    const env = setup();
    await queuedSession(env);
    env.transfer.next = async () => {
      (await env.sessions.findById('s1'))!.purgePhoto();
      return { image: Buffer.from('png'), engine: 'mock', durationMs: 1 };
    };
    await env.processor.process(job());
    expect([...env.storage.objects.keys()].some((k) => k.endsWith('result.png'))).toBe(false);
  });
});

describe('GenerationProcessor con un conjunto (probador)', () => {
  const OUTFIT: Record<string, GarmentItem> = {
    shirt: { id: 'shirt', name: 'Camisa', category: 'top', color: 'white' } as GarmentItem,
    jeans: { id: 'jeans', name: 'Jean', category: 'bottom', color: 'blue' } as GarmentItem,
    jacket: { id: 'jacket', name: 'Chaqueta', category: 'outerwear', color: 'black' } as GarmentItem,
    shoes: { id: 'shoes', name: 'Zapatillas', category: 'footwear', color: 'white' } as GarmentItem,
  };

  function outfitSetup() {
    const env = setup();
    const catalog = env.processor['catalog'] as unknown as Record<string, unknown>;
    catalog.findGarment = async (id: string) => OUTFIT[id];
    catalog.garmentPhoto = async (id: string) => ({ key: `catalog/garments/${id}/photo.jpg`, photoType: 'flat-lay' });
    for (const id of Object.keys(OUTFIT)) env.storage.objects.set(`catalog/garments/${id}/photo.jpg`, Buffer.from(id));
    let n = 0;
    env.transfer.next = async () => ({ image: Buffer.from(`paso-${++n}`), engine: 'mock', durationMs: 10 });
    return env;
  }

  it('viste de dentro hacia fuera, una prenda por paso sobre el resultado anterior, sin calzado', async () => {
    const env = outfitSetup();
    const ids = ['jacket', 'shoes', 'shirt', 'jeans'];
    const s = TryOnSession.start({
      id: 's1',
      garmentId: 'shirt',
      mode: 'photorealistic',
      outfit: ids.map((garmentId) => ({ garmentId, size: 'M' })),
      requester: { sid: 'sid' },
      now: new Date(),
    });
    s.attachPhoto(new Date(), 24);
    s.requestGeneration();
    await env.storage.put(s.photoKey!, Buffer.from('persona'));
    await env.sessions.create(s);

    await env.processor.process(job());

    expect(env.transfer.calls.map((c) => c.garments.map((g) => g.name))).toEqual([['Jean'], ['Camisa'], ['Chaqueta']]);
    expect(env.transfer.calls.map((c) => c.person.toString())).toEqual(['persona', 'paso-1', 'paso-2']);
    expect(new Set(env.transfer.calls.map((c) => c.requestId)).size).toBe(3);
    const done = (await env.sessions.findById('s1'))!;
    expect(done.status).toBe('done');
    expect(env.storage.objects.get(done.resultKey!)?.toString()).toBe('paso-3');
    expect(env.emit).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', progress: expect.any(Number) }));
    expect(env.record).toHaveBeenCalledWith('generation-completed', expect.objectContaining({ durationMs: 30 }));
  });

  it('un conjunto solo de calzado no llama a la IA y ofrece la vista instantánea', async () => {
    const env = outfitSetup();
    const s = TryOnSession.start({
      id: 's1', garmentId: 'shoes', mode: 'photorealistic', outfit: [{ garmentId: 'shoes', size: '42' }],
      requester: { sid: 'sid' }, now: new Date(),
    });
    s.attachPhoto(new Date(), 24);
    s.requestGeneration();
    await env.storage.put(s.photoKey!, Buffer.from('persona'));
    await env.sessions.create(s);
    await env.processor.process(job());
    // Una sola prenda: va tal cual al motor, que responde si la sabe poner.
    expect(env.transfer.calls).toHaveLength(1);
  });
});
