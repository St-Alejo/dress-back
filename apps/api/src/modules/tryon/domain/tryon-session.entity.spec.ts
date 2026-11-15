import { DomainError, TryOnSession } from './tryon-session.entity';

const now = new Date('2026-01-01T10:00:00Z');
const requester = { sid: '11111111-1111-1111-1111-111111111111' };
const start = () => TryOnSession.start({ id: 's1', garmentId: 'g1', mode: 'similar-model', requester, now });

describe('TryOnSession', () => {
  it('empieza sin foto ni cuenta', () => {
    const dto = start().toDto();
    expect(dto.uploadedPhotoUrl).toBeUndefined();
    expect(dto.userId).toBeUndefined();
    expect(dto.generationStatus).toBe('idle');
  });

  it('adjuntar foto pasa a fotorrealista con TTL', () => {
    const s = start();
    s.attachPhoto(now, 24);
    expect(s.mode).toBe('photorealistic');
    expect(s.toDto().photoExpiresAt).toBe('2026-01-02T10:00:00.000Z');
    expect(s.isExpired(new Date('2026-01-02T10:00:01Z'))).toBe(true);
  });

  it('no se puede generar sin foto', () => {
    expect(() => start().requestGeneration()).toThrow(DomainError);
  });

  it('no permite dos generaciones simultáneas', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration();
    expect(() => s.requestGeneration()).toThrow(DomainError);
    expect(() => s.attachPhoto(now, 24)).toThrow(DomainError);
  });

  it('purgar borra foto y resultado no guardado', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration();
    s.complete();
    expect(s.purgePhoto().sort()).toEqual(['uploads/sessions/s1/photo.jpg', 'uploads/sessions/s1/result.png']);
    expect(s.toDto().resultImageUrl).toBeUndefined();
  });

  it('un resultado guardado en la cuenta sobrevive a la purga', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration();
    s.complete();
    s.saveResult('u1');
    expect(s.purgePhoto()).toEqual(['uploads/sessions/s1/photo.jpg']);
    expect(s.resultKey).toBe('saved/u1/s1.png');
  });

  it('no deja cambiar la foto mientras se genera, antes de borrar nada', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration();
    expect(() => s.assertPhotoChangeable()).toThrow(DomainError);
    expect(s.photoKey).toBe('uploads/sessions/s1/photo.jpg');
  });

  it('regenerar tras guardar deja el nuevo resultado sujeto a la purga', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration();
    s.complete();
    s.saveResult('u1');
    s.requestGeneration();
    s.complete();
    expect(s.toDto().resultSaved).toBe(false);
    expect(s.purgePhoto().sort()).toEqual(['uploads/sessions/s1/photo.jpg', 'uploads/sessions/s1/result.png']);
  });

  it('pertenece a su sid o a su cuenta, a nadie más', () => {
    const s = start();
    expect(s.isOwnedBy(requester)).toBe(true);
    expect(s.isOwnedBy({ sid: 'otro' })).toBe(false);
  });

  it('fallar deja el motivo y permite reintentar', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration(now);
    s.markProcessing(now);
    s.fail('stuck', now);
    expect(s.toDto()).toMatchObject({ generationStatus: 'failed', failureReason: 'stuck' });
    s.requestGeneration(now);
    expect(s.toDto()).toMatchObject({ generationStatus: 'queued', failureReason: undefined });
  });

  it('el fallback también es reintentable', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration(now);
    s.fallback('not-configured', now);
    expect(s.isInFlight).toBe(false);
    expect(() => s.requestGeneration(now)).not.toThrow();
  });

  it('no se puede marcar en proceso algo que no está en curso', () => {
    expect(() => start().markProcessing(now)).toThrow(DomainError);
  });

  it('detecta generaciones atascadas por tiempo sin cambio de estado', () => {
    const s = start();
    s.attachPhoto(now, 24);
    s.requestGeneration(now);
    expect(s.isStuck(new Date(now.getTime() + 60_000), 120_000)).toBe(false);
    expect(s.isStuck(new Date(now.getTime() + 180_000), 120_000)).toBe(true);
    s.markProcessing(new Date(now.getTime() + 170_000));
    expect(s.isStuck(new Date(now.getTime() + 180_000), 120_000)).toBe(false);
  });
});

describe('TryOnSession con conjunto', () => {
  it('la prenda principal tiene que estar en el conjunto', () => {
    expect(() =>
      TryOnSession.start({ id: 's', garmentId: 'a', mode: 'photorealistic', outfit: [{ garmentId: 'b', size: 'M' }], requester: { sid: 'x' }, now: new Date() }),
    ).toThrow();
  });

  it('expone las prendas del conjunto y las devuelve en el DTO', () => {
    const outfit = [{ garmentId: 'a', size: 'M' }, { garmentId: 'b', size: '40' }];
    const s = TryOnSession.start({ id: 's', garmentId: 'a', mode: 'photorealistic', outfit, requester: { sid: 'x' }, now: new Date() });
    expect(s.garmentIds).toEqual(['a', 'b']);
    expect(s.toDto().outfit).toEqual(outfit);
  });
});
