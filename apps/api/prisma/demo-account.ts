import * as argon2 from 'argon2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { ObjectStorage } from '../src/common/storage';

/** La persona de la cuenta demo: el modelo "athletic" del catálogo (foto de Pexels, con su crédito). */
const DEMO_BODY = 'b05';
/**
 * Medidas que estimó gpt-4.1-mini sobre esa foto con 176 cm (prueba del 2026-11-15). Se guardan
 * como estimadas por la IA: la demo no vuelve a gastar crédito al crearse.
 */
const DEMO_PROFILE = { heightCm: 176, chestCm: 96, waistCm: 80, hipCm: 94, shoulderCm: 44 };

/**
 * Cuenta demo con perfil (foto y medidas) ya cargado y el consentimiento dado. Idempotente:
 * se puede correr sola (`npm run db:seed:demo`) sin borrar el catálogo ni las pruebas.
 */
export async function seedDemoAccount(prisma: PrismaClient, storage: ObjectStorage, photosDir: string) {
  const email = process.env.DEMO_EMAIL ?? 'demo@vestirse.local';
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await argon2.hash(process.env.DEMO_PASSWORD ?? 'demo12345'), role: 'user' },
  });
  const photoKey = `saved/profiles/${user.id}/demo.jpg`;
  await storage.put(photoKey, readFileSync(join(photosDir, 'bodies', `${DEMO_BODY}.jpg`)), 'image/jpeg');
  const profile = { ...DEMO_PROFILE, aiFields: ['chestCm', 'waistCm', 'hipCm', 'shoulderCm'], photoKey };
  await prisma.bodyProfile.upsert({
    where: { userId: user.id },
    update: profile,
    create: { userId: user.id, consentAt: new Date(), ...profile },
  });
  return email;
}
