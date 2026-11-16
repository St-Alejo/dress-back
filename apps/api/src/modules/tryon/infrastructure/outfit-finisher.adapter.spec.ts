import type { ConfigService } from '@nestjs/config';
import { WorkerOutfitFinisher } from './outfit-finisher.adapter';

const config = { getOrThrow: () => 'http://worker', get: () => 'secreto' } as unknown as ConfigService;
const req = {
  requestId: 's1-1-finish',
  person: Buffer.from('persona'),
  pieces: [{ image: Buffer.from('camisa'), mime: 'image/jpeg', category: 'top' as const, name: 'Camisa', delta: 1 }],
};

describe('WorkerOutfitFinisher', () => {
  afterEach(() => jest.restoreAllMocks());

  it('manda el manifest con las tallas y devuelve la imagen del worker', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('png'), { status: 200, headers: { 'X-Engine': 'openai:gpt-image-1-mini', 'X-Duration-Ms': '30000' } }),
    );
    const out = await new WorkerOutfitFinisher(config).finish(req);
    expect(out).toEqual({ image: Buffer.from('png'), engine: 'openai:gpt-image-1-mini', durationMs: 30000 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://worker/v1/finish');
    const form = init!.body as FormData;
    expect(JSON.parse(form.get('manifest') as string)).toEqual({ mode: 'retouch', body: '', pieces: [{ index: 0, category: 'top', name: 'Camisa', delta: 1, openFront: false }] });
    expect((init!.headers as Record<string, string>)['X-Worker-Token']).toBe('secreto');
  });

  it('si el worker rechaza o no responde, devuelve null (la prueba sigue sin acabado)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ code: 'not-configured' }), { status: 412 }));
    expect(await new WorkerOutfitFinisher(config).finish(req)).toBeNull();
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await new WorkerOutfitFinisher(config).finish(req)).toBeNull();
  });
});
