import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client';
import { S3ObjectStorage } from '../src/common/storage';
import { fitIntentFor } from '../src/modules/catalog/domain/garment-grading';
import { sizeRows } from '../src/modules/catalog/infrastructure/size-rows';
import { BODIES, BRANDS, GARMENTS } from '../src/seed/seed-data';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const storage = new S3ObjectStorage(new ConfigService(process.env));

/** Fotos reales con licencia libre, ya normalizadas (créditos en seed/photos/{garments,bodies}/credits.json). */
const PHOTOS_DIR = join(__dirname, '../../../seed/photos');

async function publish(kind: 'garments' | 'bodies', key: string, file: string, name: string, type: string): Promise<string | undefined> {
  const path = join(PHOTOS_DIR, kind, file);
  if (!existsSync(path)) return undefined;
  const objectKey = `catalog/${kind}/${key}/${name}`;
  await storage.put(objectKey, readFileSync(path), type);
  return objectKey;
}

/** JSON opcional junto a las fotos (anclas de una prenda, pose de un modelo). */
function readJson(kind: 'garments' | 'bodies', file: string) {
  const path = join(PHOTOS_DIR, kind, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/** La tienda no tiene imagen de respaldo: una prenda o un modelo sin foto es un error del seed. */
async function publishPhoto(kind: 'garments' | 'bodies', key: string): Promise<string> {
  const objectKey = await publish(kind, key, `${key}.jpg`, 'photo.jpg', 'image/jpeg');
  if (!objectKey) throw new Error(`falta la foto seed/photos/${kind}/${key}.jpg`);
  return objectKey;
}

async function main() {
  await storage.onModuleInit();

  // Idempotente: se limpia el catálogo (las sesiones dependen de prendas, se limpian también).
  await prisma.tryOnSession.deleteMany();
  await prisma.fitReview.deleteMany();
  await prisma.bodyModelPreview.deleteMany();
  await prisma.sizeChartEntry.deleteMany();
  await prisma.garment.deleteMany();
  await prisma.bodyModel.deleteMany();
  await prisma.brandCalibration.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.metricEvent.deleteMany();

  const brandIds: Record<string, string> = {};
  for (const b of BRANDS) {
    const brand = await prisma.brand.create({ data: { name: b.name } });
    brandIds[b.key] = brand.id;
    for (const c of b.calibration ?? []) {
      await prisma.brandCalibration.create({ data: { brandId: brand.id, ...c } });
    }
  }

  for (const g of GARMENTS) {
    await prisma.garment.create({
      data: {
        name: g.name,
        brandId: brandIds[g.brand],
        category: g.category,
        style: g.style,
        color: g.color,
        priceCents: g.priceCents,
        photoKey: await publishPhoto('garments', g.key),
        photoType: g.photoType,
        cutoutKey: await publish('garments', g.key, `${g.key}.cutout.webp`, 'cutout.webp', 'image/webp'),
        thumbKey: await publish('garments', g.key, `${g.key}.w384.webp`, 'thumb.webp', 'image/webp'),
        overlayAnchors: readJson('garments', `${g.key}.anchors.json`),
        fabricNotes: g.fabricNotes,
        stretch: g.stretch,
        knownLimitations: g.knownLimitations ?? [],
        fitIntent: fitIntentFor(g.style) ?? undefined,
        sizeChart: { create: sizeRows(g.style, g.sizeChart) },
      },
    });
  }

  for (const [i, b] of BODIES.entries()) {
    await prisma.bodyModel.create({
      data: {
        bodyTypeTag: b.bodyTypeTag,
        typicalSize: b.typicalSize,
        heightMin: b.heightRange[0],
        heightMax: b.heightRange[1],
        skinTone: b.skinTone,
        shape: { ...b.shape },
        photoKey: await publishPhoto('bodies', b.key),
        pose: readJson('bodies', `${b.key}.pose.json`),
        onePiece: b.onePiece ?? false,
        handsInPockets: b.handsInPockets ?? false,
        sortOrder: i,
      },
    });
  }

  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@vestirse.local';
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: { email: adminEmail, passwordHash: await argon2.hash(process.env.ADMIN_PASSWORD ?? 'admin1234'), role: 'admin' },
  });

  console.log(`seed: ${BRANDS.length} marcas, ${GARMENTS.length} prendas, ${BODIES.length} cuerpos, admin ${adminEmail}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
