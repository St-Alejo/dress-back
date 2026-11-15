/**
 * Invariantes éticas verificables (sección 4 y sección 15, punto 4).
 * Si alguna falla, no es un test "roto": es una regla de producto violada.
 */
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORBIDDEN_ROUTE_PATTERN, LETTER_SIZES } from '@vestirse/shared-types';
import { AdminController } from './modules/admin/admin.module';
import { AuthController } from './modules/auth/auth.module';
import { coverageViolations } from './modules/catalog/domain/body-coverage';
import { CatalogController, MediaController } from './modules/catalog/interface/catalog.controller';
import { BodyGeometry, REFERENCE_SHAPE } from './modules/catalog/domain/body-geometry';
import { FitController } from './modules/fit/fit.module';
import { MetricsController } from './modules/metrics/metrics.module';
import { PrivacyController } from './modules/privacy/privacy.module';
import { ProfileController, ProfileDto } from './modules/profile/profile.module';
import { ReviewsController } from './modules/reviews/reviews.module';
import { TryOnController } from './modules/tryon/interface/tryon.controller';
import { BODIES } from './seed/seed-data';

const CONTROLLERS = [
  AdminController, AuthController, CatalogController, MediaController, FitController,
  MetricsController, PrivacyController, ProfileController, ReviewsController, TryOnController,
];

function routesOf(controller: new (...args: never[]) => unknown): string[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .filter((name) => Reflect.getMetadata(METHOD_METADATA, proto[name] as object) !== undefined)
    .map((name) => {
      const fn = proto[name] as object;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
      const path = [base, Reflect.getMetadata(PATH_METADATA, fn) as string]
        .flatMap((p) => p.split('/'))
        .filter(Boolean)
        .join('/');
      return `${method} /${path}`;
    });
}

describe('invariantes éticas de la API', () => {
  const routes = CONTROLLERS.flatMap(routesOf);

  it('descubre las rutas de todos los controladores', () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it('regla 2 y 3: no existe ninguna ruta de edición de silueta ni de comparación entre usuarios', () => {
    const offending = routes.filter((r) => FORBIDDEN_ROUTE_PATTERN.test(r));
    expect(offending).toEqual([]);
  });

  it('el patrón prohibido sí detecta rutas peligrosas (el test no es trivial)', () => {
    for (const bad of ['POST /body/slim', 'PATCH /photo/reshape', 'GET /leaderboard', 'POST /silhouette-edit', 'GET /compare-users']) {
      expect(FORBIDDEN_ROUTE_PATTERN.test(bad)).toBe(true);
    }
  });

  it('regla 1: subir foto es un endpoint aparte y opcional; crear sesión no requiere foto', () => {
    expect(routes).toContain('POST /tryon/sessions');
    expect(routes).toContain('POST /tryon/sessions/:id/photo');
  });

  it('regla 4: el catálogo semilla cubre XS–4XL y al menos 10 tipos de cuerpo', () => {
    expect(coverageViolations(BODIES)).toEqual([]);
    for (const size of LETTER_SIZES) expect(BODIES.some((b) => b.typicalSize === size)).toBe(true);
    const heights = BODIES.map((b) => b.shape.heightCm);
    expect(Math.min(...heights)).toBeLessThanOrEqual(155);
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(185);
    expect(new Set(BODIES.map((b) => b.skinTone)).size).toBeGreaterThanOrEqual(5);
  });

  it('regla 4: la regla de cobertura detecta un catálogo incompleto', () => {
    expect(coverageViolations(BODIES.filter((b) => b.typicalSize !== '4XL'))).not.toEqual([]);
  });

  it('regla 2: la geometría del cuerpo solo acepta medidas reales, sin parámetros de "estilizar"', () => {
    expect(Object.keys(REFERENCE_SHAPE).sort()).toEqual(['chestCm', 'heightCm', 'hipCm', 'shoulderCm', 'waistCm']);
    expect(Object.getOwnPropertyNames(BodyGeometry.prototype).filter((n) => /slim|reshape|thin|beautif/i.test(n))).toEqual([]);
  });

  it('ADR 0004: el perfil con foto y medidas solo se guarda con un sí explícito', () => {
    const errors = (body: object) => validateSync(plainToInstance(ProfileDto, body)).length;
    expect(errors({ heightCm: 170 })).toBeGreaterThan(0);
    expect(errors({ consent: false, heightCm: 170 })).toBeGreaterThan(0);
    expect(errors({ consent: true, heightCm: 170 })).toBe(0);
  });

  it('sección 8.4: el consentimiento de reentrenamiento es false por defecto en el esquema', () => {
    const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/retrainingConsent\s+Boolean\s+@default\(false\)/);
  });

  it('sección 8: las fotos nunca se guardan en la base de datos (sin columnas binarias)', () => {
    const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/\bBytes\b/);
  });
});
