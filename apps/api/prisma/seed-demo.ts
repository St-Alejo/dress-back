import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client';
import { S3ObjectStorage } from '../src/common/storage';
import { seedDemoAccount } from './demo-account';

/** Solo la cuenta demo: no toca el catálogo ni las pruebas ya generadas. */
async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const storage = new S3ObjectStorage(new ConfigService(process.env));
  await storage.onModuleInit();
  try {
    console.log(`demo: ${await seedDemoAccount(prisma, storage, join(__dirname, '../../../seed/photos'))}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
