/**
 * Genera los conjuntos favoritos de la cuenta demo (él y su esposa) con la IA real, una sola vez:
 * las imágenes quedan en seed/favorites/ y `db:seed:demo` las carga sin volver a gastar.
 *
 *   npx tsx prisma/generate-demo-favorites.ts            # genera los que falten
 *   npx tsx prisma/generate-demo-favorites.ts --only=id  # rehace uno (p. ej. si salió mal)
 *
 * Cada escenario: talla recomendada con el motor de tallas para esa persona, la talla probada
 * (la recomendada ± n) → FASHN en la GPU local viste prenda a prenda → acabado con IA de imagen
 * (tela realista, holgura según la talla y los zapatos). Necesita el worker y la GPU levantados.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { FitEngine } from '@vestirse/fit-engine';
import { AI_DRESSING_ORDER, AI_WEARABLE, type GarmentCategory, type SizeChartEntry } from '@vestirse/shared-types';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { PrismaClient } from '../src/generated/prisma/client';
import { GARMENTS } from '../src/seed/seed-data';
import { DEMO_PROFILE, DEMO_SCENARIOS, WIFE_PROFILE, type DemoScenario } from './demo-favorites';

const SEED = join(__dirname, '../../../seed');
const OUT = join(SEED, 'favorites');
const WORKER = process.env.AI_WORKER_URL ?? 'http://localhost:8011';
const engine = new FitEngine();

interface DbGarment {
  id: string;
  name: string;
  category: GarmentCategory;
  color: string;
  photoType: string;
  stretch: 'none' | 'low' | 'medium' | 'high';
  fitIntent: unknown;
  sizeChart: SizeChartEntry[];
}

const CATEGORY_WORD: Partial<Record<GarmentCategory, string>> = {
  top: 'La prenda de arriba',
  outerwear: 'La chaqueta',
  bottom: 'El pantalón',
  dress: 'El vestido',
};

/** Nota legible del escenario: qué talla se probó frente a la recomendada y qué se ve. */
export function scenarioNote(items: { name: string; category: GarmentCategory; size: string; recommendedSize?: string; delta: number }[]): string {
  const off = items.filter((i) => i.delta !== 0 && i.recommendedSize);
  if (!off.length) return 'Todo en su talla recomendada: así le queda de verdad.';
  return off
    .map((i) => {
      const how = i.delta > 0 ? (i.delta > 1 ? 'muy holgada, estilo oversize' : 'le queda grande y holgada') : 'le queda justa y ajustada';
      return `${CATEGORY_WORD[i.category] ?? i.name} (${i.name}) en talla ${i.size} cuando su talla es ${i.recommendedSize}: ${how}.`;
    })
    .join(' ');
}

async function worker(path: string, form: FormData, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await fetch(`${WORKER}${path}`, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fashn(person: Buffer, garment: DbGarment, image: Buffer, requestId: string): Promise<Buffer> {
  const form = new FormData();
  form.append('person_image', new Blob([new Uint8Array(person)], { type: 'image/png' }), 'person.png');
  form.append('garment_images', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'garment.jpg');
  form.append(
    'manifest',
    JSON.stringify({
      contractVersion: '1',
      requestId,
      garments: [{ index: 0, category: garment.category, name: garment.name, color: garment.color, fit: 'regular fit', photoType: garment.photoType === 'model' ? 'model' : 'flat-lay' }],
      bodyBrief: 'person as shown in the photo',
    }),
  );
  return worker('/v1/generate', form, { 'X-AI-Provider': 'hf-chain', 'X-Request-Id': requestId });
}

async function finish(person: Buffer, pieces: { image: Buffer; category: GarmentCategory; name: string; delta: number }[], requestId: string): Promise<Buffer> {
  const form = new FormData();
  form.append('person_image', new Blob([new Uint8Array(person)], { type: 'image/png' }), 'person.png');
  pieces.forEach((p, i) => form.append('item_images', new Blob([new Uint8Array(p.image)], { type: 'image/jpeg' }), `item-${i}.jpg`));
  form.append('manifest', JSON.stringify({ pieces: pieces.map(({ category, name, delta }, index) => ({ index, category, name, delta })) }));
  return worker('/v1/finish', form, { 'X-Request-Id': requestId });
}

function recommended(g: DbGarment, profile: typeof DEMO_PROFILE): string | undefined {
  try {
    return engine.recommend({ measurements: profile, sizeChart: g.sizeChart, category: g.category, stretch: g.stretch, fitIntent: g.fitIntent as never }).recommendedSize;
  } catch {
    return undefined;
  }
}

async function generate(s: DemoScenario, byKey: Map<string, DbGarment>) {
  const profile = s.wearer === 'Él' ? DEMO_PROFILE : WIFE_PROFILE;
  const items = s.items.map(({ key, delta = 0 }) => {
    const g = byKey.get(key);
    if (!g) throw new Error(`prenda ${key} no está en la base (¿falta el seed?)`);
    const rec = recommended(g, profile);
    const sizes = g.sizeChart.map((e) => e.size);
    const base = rec ? sizes.indexOf(rec) : Math.floor(sizes.length / 2);
    const size = sizes[Math.max(0, Math.min(sizes.length - 1, base + delta))]!;
    const realDelta = rec ? sizes.indexOf(size) - sizes.indexOf(rec) : 0;
    return { key, garment: g, image: readFileSync(join(SEED, 'photos/garments', `${key}.jpg`)), size, recommendedSize: rec, delta: g.category === 'footwear' ? 0 : realDelta };
  });
  const ordered = [...items].sort((a, b) => AI_DRESSING_ORDER[a.garment.category] - AI_DRESSING_ORDER[b.garment.category]);

  let person: Buffer = readFileSync(join(SEED, 'photos/bodies', `${s.body}.jpg`));
  for (const [step, it] of ordered.filter((i) => AI_WEARABLE.includes(i.garment.category)).entries()) {
    const t = Date.now();
    person = await fashn(person, it.garment, it.image, `demo-${s.id}-${step}`);
    console.log(`  FASHN ${it.garment.name} (${Math.round((Date.now() - t) / 1000)} s)`);
  }
  writeFileSync(join(OUT, `${s.id}.fashn.png`), person);
  const t = Date.now();
  const final = await finish(person, ordered.map((i) => ({ image: i.image, category: i.garment.category, name: i.garment.name, delta: i.delta })), `demo-${s.id}-finish`);
  console.log(`  acabado (${Math.round((Date.now() - t) / 1000)} s)`);
  writeFileSync(join(OUT, `${s.id}.jpg`), await sharp(final).jpeg({ quality: 88, mozjpeg: true }).toBuffer());
  return {
    id: s.id,
    wearer: s.wearer,
    body: s.body,
    title: s.title,
    note: scenarioNote(items.map((i) => ({ name: i.garment.name, category: i.garment.category, size: i.size, recommendedSize: i.recommendedSize, delta: i.delta }))),
    items: items.map((i) => ({ name: i.garment.name, size: i.size, ...(i.recommendedSize ? { recommendedSize: i.recommendedSize } : {}) })),
  };
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const rows = await prisma.garment.findMany({ include: { sizeChart: { orderBy: { sortOrder: 'asc' } } } });
    const byName = new Map(rows.map((r) => [r.name, r as unknown as DbGarment]));
    const byKey = new Map(GARMENTS.flatMap((g) => (byName.has(g.name) ? [[g.key, byName.get(g.name)!] as const] : [])));
    const manifestPath = join(OUT, 'favorites.json');
    const manifest: Record<string, unknown>[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
    for (const s of DEMO_SCENARIOS) {
      const done = existsSync(join(OUT, `${s.id}.jpg`)) && manifest.some((m) => m.id === s.id);
      if (done && only !== s.id) continue;
      if (only && only !== s.id) continue;
      console.log(`${s.id}: ${s.title}`);
      try {
        const entry = await generate(s, byKey);
        const i = manifest.findIndex((m) => m.id === s.id);
        if (i >= 0) manifest[i] = entry;
        else manifest.push(entry);
        // Orden estable: el de DEMO_SCENARIOS.
        manifest.sort((a, b) => DEMO_SCENARIOS.findIndex((x) => x.id === a.id) - DEMO_SCENARIOS.findIndex((x) => x.id === b.id));
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      } catch (err) {
        console.error(`  ✗ ${(err as Error).message}`);
        if (String((err as Error).message).includes('tope')) break;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
