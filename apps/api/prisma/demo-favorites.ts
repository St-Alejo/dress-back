import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { ObjectStorage } from '../src/common/storage';

/**
 * Medidas de la persona de la cuenta demo (modelo b05): las estimó gpt-4.1-mini sobre su foto con
 * 176 cm (prueba del 2026-11-15).
 */
export const DEMO_PROFILE = { heightCm: 176, chestCm: 96, waistCm: 80, hipCm: 94 };
/** Su esposa en los favoritos de la demo: el modelo b02 del catálogo (petite-curvy, talla M). */
export const WIFE_PROFILE = { heightCm: 156, chestCm: 96, waistCm: 77, hipCm: 104 };

export interface DemoScenario {
  id: string;
  wearer: 'Él' | 'Ella';
  body: 'b05' | 'b02';
  title: string;
  /** Prendas por clave del seed; `delta` = tallas por encima (+) o por debajo (−) de la recomendada. */
  items: { key: string; delta?: number }[];
}

/** Escenarios de prueba: talla justa, una más grande (holgada), una más pequeña (ajustada) y oversize. */
export const DEMO_SCENARIOS: DemoScenario[] = [
  { id: 'el-oficina', wearer: 'Él', body: 'b05', title: 'Oficina casual', items: [{ key: 'g08' }, { key: 'g24' }, { key: 'g41' }] },
  { id: 'el-oxford-grande', wearer: 'Él', body: 'b05', title: 'La misma camisa, una talla más', items: [{ key: 'g08', delta: 1 }, { key: 'g24' }, { key: 'g41' }] },
  { id: 'el-camiseta-justa', wearer: 'Él', body: 'b05', title: 'Camiseta una talla menos', items: [{ key: 'g01', delta: -1 }, { key: 'g31' }, { key: 'g41' }] },
  { id: 'el-fin-de-semana', wearer: 'Él', body: 'b05', title: 'Fin de semana', items: [{ key: 'g15' }, { key: 'g31' }, { key: 'g41' }] },
  { id: 'el-cena', wearer: 'Él', body: 'b05', title: 'Cena con blazer', items: [{ key: 'g01' }, { key: 'g30' }, { key: 'g16' }, { key: 'g42' }] },
  { id: 'el-mezclilla', wearer: 'Él', body: 'b05', title: 'Capas de mezclilla', items: [{ key: 'g11' }, { key: 'g25' }, { key: 'g21' }, { key: 'g41' }] },
  { id: 'el-sueter-oversize', wearer: 'Él', body: 'b05', title: 'Suéter oversize (dos tallas más)', items: [{ key: 'g13', delta: 2 }, { key: 'g24' }, { key: 'g42' }] },
  { id: 'ella-vestido-rojo', wearer: 'Ella', body: 'b02', title: 'Vestido rojo de fiesta', items: [{ key: 'g36' }, { key: 'g42' }] },
  { id: 'ella-flores', wearer: 'Ella', body: 'b02', title: 'Flores y jean mom', items: [{ key: 'g09' }, { key: 'g27' }, { key: 'g41' }] },
  { id: 'ella-menta', wearer: 'Ella', body: 'b02', title: 'Blazer menta y amarillo', items: [{ key: 'g01' }, { key: 'g28' }, { key: 'g18' }, { key: 'g43' }] },
  { id: 'ella-cardigan-grande', wearer: 'Ella', body: 'b02', title: 'Cárdigan una talla más', items: [{ key: 'g12', delta: 1 }, { key: 'g27' }, { key: 'g41' }] },
  { id: 'ella-floral-justo', wearer: 'Ella', body: 'b02', title: 'Vestido floral una talla menos', items: [{ key: 'g37', delta: -1 }, { key: 'g43' }] },
  { id: 'ella-leopardo', wearer: 'Ella', body: 'b02', title: 'Leopardo y lunares', items: [{ key: 'g10' }, { key: 'g34' }, { key: 'g43' }] },
  { id: 'ella-pana-grande', wearer: 'Ella', body: 'b02', title: 'Pantalón de pana una talla más', items: [{ key: 'g11' }, { key: 'g30', delta: 1 }, { key: 'g41' }] },
];

interface ManifestEntry {
  id: string;
  wearer: string;
  body: string;
  title: string;
  note: string;
  items: { name: string; size: string; recommendedSize?: string }[];
}

/**
 * Carga en la cuenta demo los favoritos ya generados (seed/favorites). Idempotente: borra los
 * anteriores de la cuenta (filas e imágenes) y los vuelve a crear; no llama a ninguna IA.
 */
export async function seedDemoFavorites(prisma: PrismaClient, storage: ObjectStorage, userId: string, favoritesDir: string): Promise<number> {
  const manifestPath = join(favoritesDir, 'favorites.json');
  if (!existsSync(manifestPath)) return 0;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[];

  const old = await prisma.favoriteOutfit.findMany({ where: { userId }, select: { imageKey: true } });
  await storage.deleteMany(old.map((o) => o.imageKey));
  await prisma.favoriteOutfit.deleteMany({ where: { userId } });

  const garments = await prisma.garment.findMany({ select: { id: true, name: true } });
  const idByName = new Map(garments.map((g) => [g.name, g.id]));
  const bodies = await prisma.bodyModel.findMany({ select: { id: true, photoKey: true } });
  let created = 0;
  // Del último al primero: la lista sale por fecha descendente y así respeta el orden de los escenarios.
  for (const [i, entry] of [...manifest].reverse().entries()) {
    const file = join(favoritesDir, `${entry.id}.jpg`);
    const items = entry.items.flatMap((it) => {
      const garmentId = idByName.get(it.name);
      return garmentId ? [{ garmentId, size: it.size, ...(it.recommendedSize ? { recommendedSize: it.recommendedSize } : {}) }] : [];
    });
    if (!existsSync(file) || items.length === 0) continue;
    const row = await prisma.favoriteOutfit.create({
      data: {
        userId,
        title: entry.title,
        wearer: entry.wearer,
        bodyModelId: bodies.find((b) => b.photoKey.includes(entry.body))?.id ?? null,
        note: entry.note,
        imageKey: 'pendiente',
        items,
        createdAt: new Date(Date.now() - (manifest.length - i) * 60_000),
      },
    });
    const imageKey = `saved/favorites/${userId}/${row.id}.jpg`;
    await storage.put(imageKey, readFileSync(file), 'image/jpeg');
    await prisma.favoriteOutfit.update({ where: { id: row.id }, data: { imageKey } });
    created++;
  }
  return created;
}
