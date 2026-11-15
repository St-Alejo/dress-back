import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import sharp from 'sharp';

export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface UploadedPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * Valida y re-codifica una foto de persona en el servidor: aplica la orientación,
 * descarta TODOS los metadatos (EXIF/GPS) y limita la resolución.
 */
export async function cleanPhoto(file: UploadedPhoto | undefined): Promise<Buffer> {
  if (!file) throw new BadRequestException('falta la imagen');
  if (!ACCEPTED_MIME.includes(file.mimetype)) throw new UnprocessableEntityException('formato no admitido');
  if (file.size > MAX_PHOTO_BYTES) throw new UnprocessableEntityException('imagen demasiado grande');
  try {
    return await sharp(file.buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    throw new UnprocessableEntityException('la imagen no se pudo leer');
  }
}
