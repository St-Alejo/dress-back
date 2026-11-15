import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Put,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Equals, IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';
import type { BodyEstimate, ProfileMeasure, ProfilePhotoResult, SavedProfile } from '@vestirse/shared-types';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { AuthGuard } from '../../common/guards';
import { cleanPhoto, MAX_PHOTO_BYTES, type UploadedPhoto } from '../../common/photo';
import { PrismaService } from '../../common/prisma.service';
import { CurrentRequester, type Requester } from '../../common/requester';
import { ObjectStorage } from '../../common/storage';
import { AiSettingsModule, AiWorkerClient } from '../ai-settings/ai-settings.module';

export const MEASURES: ProfileMeasure[] = ['chestCm', 'waistCm', 'hipCm', 'shoulderCm'];

/** Fila guardada (la forma de Prisma, sin depender del cliente generado). */
export interface ProfileRow {
  userId: string;
  heightCm: number;
  weightKg: number | null;
  chestCm: number | null;
  waistCm: number | null;
  hipCm: number | null;
  shoulderCm: number | null;
  aiFields: string[];
  photoKey: string | null;
  consentAt: Date;
  updatedAt: Date;
}

/**
 * Lo que la IA midió entra solo donde la persona no escribió nada: una medida tomada con
 * cinta nunca se pisa. Devuelve los campos a actualizar.
 */
export function mergeEstimate(row: Pick<ProfileRow, ProfileMeasure | 'aiFields'>, estimate: BodyEstimate) {
  const update: Partial<Record<ProfileMeasure, number>> = {};
  const aiFields = new Set(row.aiFields);
  if (!estimate.usable || !estimate.measurements) return { update, aiFields: [...aiFields] };
  for (const key of MEASURES) {
    const value = estimate.measurements[key];
    const typedByPerson = row[key] !== null && !aiFields.has(key);
    if (value === undefined || typedByPerson) continue;
    update[key] = value;
    aiFields.add(key);
  }
  return { update, aiFields: [...aiFields] };
}

export function toDto(row: ProfileRow): SavedProfile {
  const opt = (v: number | null) => v ?? undefined;
  return {
    heightCm: row.heightCm,
    weightKg: opt(row.weightKg),
    chestCm: opt(row.chestCm),
    waistCm: opt(row.waistCm),
    hipCm: opt(row.hipCm),
    shoulderCm: opt(row.shoulderCm),
    aiFields: row.aiFields.filter((f): f is ProfileMeasure => (MEASURES as string[]).includes(f)),
    hasPhoto: !!row.photoKey,
    consentAt: row.consentAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ProfileDto {
  /** Sin este sí explícito no se guarda nada. */
  @IsBoolean() @Equals(true) consent: boolean;
  @IsNumber() @Min(120) @Max(230) heightCm: number;
  @IsOptional() @IsNumber() @Min(30) @Max(300) weightKg?: number | null;
  @IsOptional() @IsNumber() @Min(50) @Max(200) chestCm?: number | null;
  @IsOptional() @IsNumber() @Min(40) @Max(200) waistCm?: number | null;
  @IsOptional() @IsNumber() @Min(50) @Max(200) hipCm?: number | null;
  @IsOptional() @IsNumber() @Min(25) @Max(70) shoulderCm?: number | null;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly worker: AiWorkerClient,
  ) {}

  private find(userId: string): Promise<ProfileRow | null> {
    return this.prisma.bodyProfile.findUnique({ where: { userId } });
  }

  async get(userId: string): Promise<SavedProfile | null> {
    const row = await this.find(userId);
    return row ? toDto(row) : null;
  }

  /** Guardar o editar. Una medida escrita aquí deja de contar como estimada por la IA. */
  async save(userId: string, dto: ProfileDto): Promise<SavedProfile> {
    const existing = await this.find(userId);
    const aiFields = new Set(existing?.aiFields ?? []);
    const measures: Partial<Record<ProfileMeasure, number | null>> = {};
    for (const key of MEASURES) {
      if (dto[key] === undefined) continue;
      if (existing && dto[key] === existing[key]) continue; // sin cambios: conserva su origen
      measures[key] = dto[key] ?? null;
      aiFields.delete(key);
    }
    const data = { heightCm: dto.heightCm, weightKg: dto.weightKg ?? null, ...measures, aiFields: [...aiFields] };
    const row = await this.prisma.bodyProfile.upsert({
      where: { userId },
      create: { userId, consentAt: new Date(), ...data },
      update: data,
    });
    return toDto(row);
  }

  /**
   * Foto del perfil: se limpia (EXIF fuera), se guarda fuera de `uploads/` y la IA estima las
   * medidas que falten una sola vez por foto y altura (el worker cachea por hash).
   */
  async setPhoto(userId: string, file: UploadedPhoto | undefined): Promise<ProfilePhotoResult> {
    const existing = await this.find(userId);
    if (!existing) throw new BadRequestException('primero guarda tu perfil con tu consentimiento');
    const clean = await cleanPhoto(file);
    const key = `saved/profiles/${userId}/${randomUUID()}.jpg`;
    await this.storage.put(key, clean, 'image/jpeg');
    if (existing.photoKey) await this.storage.deleteMany([existing.photoKey]);

    const [photoCheck, estimate] = await Promise.all([this.worker.inspectPhoto(clean), this.worker.estimateBody(clean, existing.heightCm)]);
    const { update, aiFields } = mergeEstimate(existing, estimate);
    const row = await this.prisma.bodyProfile.update({ where: { userId }, data: { photoKey: key, ...update, aiFields } });
    return { profile: toDto(row), estimate, ...(photoCheck.checked ? { photoCheck } : {}) };
  }

  /** Volver a medir con la foto guardada (por ejemplo tras corregir la altura). */
  async remeasure(userId: string): Promise<ProfilePhotoResult> {
    const existing = await this.find(userId);
    if (!existing?.photoKey) throw new BadRequestException('el perfil no tiene foto');
    const image = await this.storage.getBuffer(existing.photoKey);
    if (!image) throw new BadRequestException('la foto del perfil no está disponible');
    const estimate = await this.worker.estimateBody(image, existing.heightCm);
    const { update, aiFields } = mergeEstimate(existing, estimate);
    const row = await this.prisma.bodyProfile.update({ where: { userId }, data: { ...update, aiFields } });
    return { profile: toDto(row), estimate };
  }

  async photo(userId: string) {
    const row = await this.find(userId);
    const obj = row?.photoKey ? await this.storage.get(row.photoKey) : null;
    if (!obj) throw new NotFoundException();
    return obj;
  }

  async deletePhoto(userId: string): Promise<SavedProfile | null> {
    const row = await this.find(userId);
    if (!row) return null;
    if (row.photoKey) await this.storage.deleteMany([row.photoKey]);
    return toDto(await this.prisma.bodyProfile.update({ where: { userId }, data: { photoKey: null } }));
  }

  /** Retirar el consentimiento = borrar perfil y foto de verdad. */
  async remove(userId: string): Promise<{ deleted: boolean }> {
    const row = await this.find(userId);
    if (!row) return { deleted: false };
    if (row.photoKey) await this.storage.deleteMany([row.photoKey]);
    await this.prisma.bodyProfile.delete({ where: { userId } });
    return { deleted: true };
  }
}

@UseGuards(AuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  async get(@CurrentRequester() r: Requester) {
    return { profile: await this.profiles.get(r.userId!) };
  }

  @Put()
  save(@CurrentRequester() r: Requester, @Body() dto: ProfileDto) {
    return this.profiles.save(r.userId!, dto);
  }

  @Post('photo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  setPhoto(@CurrentRequester() r: Requester, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.profiles.setPhoto(r.userId!, file);
  }

  @Post('measure')
  @HttpCode(200)
  remeasure(@CurrentRequester() r: Requester) {
    return this.profiles.remeasure(r.userId!);
  }

  @Get('photo')
  async photo(@CurrentRequester() r: Requester, @Res() res: Response) {
    const obj = await this.profiles.photo(r.userId!);
    res.setHeader('Content-Type', obj.contentType ?? 'image/jpeg');
    // Imagen del cuerpo: nunca en caché compartida ni del service worker.
    res.setHeader('Cache-Control', 'private, no-store');
    obj.body.pipe(res);
  }

  @Delete('photo')
  deletePhoto(@CurrentRequester() r: Requester) {
    return this.profiles.deletePhoto(r.userId!);
  }

  @Delete()
  @HttpCode(200)
  remove(@CurrentRequester() r: Requester) {
    return this.profiles.remove(r.userId!);
  }
}

@Module({
  imports: [AiSettingsModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
