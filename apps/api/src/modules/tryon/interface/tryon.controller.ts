import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, Equals, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import type { TryOnMode } from '@vestirse/shared-types';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentRequester, type Requester } from '../../../common/requester';
import { MAX_PHOTO_BYTES, TryOnService } from '../application/tryon.service';

const MODES: TryOnMode[] = ['similar-model', 'live-overlay', 'photorealistic'];

class OutfitItemDto {
  @IsUUID() garmentId: string;
  @IsString() @MaxLength(10) size: string;
}

class StartSessionDto {
  @IsUUID() garmentId: string;
  @IsIn(MODES) mode: TryOnMode;
  @IsOptional() @IsUUID() bodyModelId?: string;
  /** Probador: varias prendas a la vez, una por zona del cuerpo. */
  @IsOptional() @ValidateNested({ each: true }) @Type(() => OutfitItemDto) @ArrayMinSize(1) @ArrayMaxSize(5) outfit?: OutfitItemDto[];
}

class ChangeModeDto {
  @IsIn(MODES) mode: TryOnMode;
}

class PhotoFieldsDto {
  /** El checklist de privacidad se muestra siempre antes de subir (sección 8.6). */
  @Equals('true') privacyAcknowledged: string;
}

@Controller('tryon/sessions')
export class TryOnController {
  constructor(private readonly tryon: TryOnService) {}

  @Post()
  start(@Body() dto: StartSessionDto, @CurrentRequester() r: Requester) {
    return this.tryon.start(dto, r);
  }

  @Get()
  list(@CurrentRequester() r: Requester) {
    return this.tryon.list(r);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester) {
    return this.tryon.get(id, r);
  }

  @Patch(':id/mode')
  changeMode(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeModeDto, @CurrentRequester() r: Requester) {
    return this.tryon.changeMode(id, dto.mode, r);
  }

  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('photo', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() fields: PhotoFieldsDto,
    @CurrentRequester() r: Requester,
  ) {
    if (fields.privacyAcknowledged !== 'true') throw new BadRequestException();
    return this.tryon.uploadPhoto(id, file, r);
  }

  @Delete(':id/photo')
  deletePhoto(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester) {
    return this.tryon.deletePhoto(id, r);
  }

  @Post(':id/generate')
  generate(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester) {
    return this.tryon.requestGeneration(id, r);
  }

  @Post(':id/save')
  save(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester) {
    return this.tryon.saveResult(id, r);
  }

  @Get(':id/photo')
  photo(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester, @Res() res: Response) {
    return this.stream(id, 'photo', r, res);
  }

  @Get(':id/result')
  result(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester, @Res() res: Response) {
    return this.stream(id, 'result', r, res);
  }

  private async stream(id: string, kind: 'photo' | 'result', r: Requester, res: Response) {
    const obj = await this.tryon.privateImage(id, kind, r);
    res.setHeader('Content-Type', obj.contentType ?? 'image/jpeg');
    // Imágenes del cuerpo: nunca en caché compartida ni del service worker.
    res.setHeader('Cache-Control', 'private, no-store');
    obj.body.pipe(res);
  }
}
