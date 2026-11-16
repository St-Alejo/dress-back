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
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { FavoriteOutfit, FavoriteOutfitItem, GarmentItem } from '@vestirse/shared-types';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthGuard } from '../../common/guards';
import { PrismaService } from '../../common/prisma.service';
import { CurrentRequester, type Requester } from '../../common/requester';
import { ObjectStorage } from '../../common/storage';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogRepository } from '../catalog/application/catalog.repository';
import { RecommendedSizes } from '../tryon/application/outfit-finish';
import { TryOnSessionRepository } from '../tryon/application/tryon-session.repository';
import { TryOnModule } from '../tryon/tryon.module';
import { TryOnSessionsPersistenceModule } from '../tryon/tryon-persistence.module';

/** Lo que se guarda por prenda (JSON en la fila). */
export interface StoredItem {
  garmentId: string;
  size: string;
  recommendedSize?: string;
}

/** Fila guardada (la forma de Prisma, sin depender del cliente generado). */
export interface FavoriteRow {
  id: string;
  userId: string;
  title: string;
  wearer: string | null;
  bodyModelId: string | null;
  imageKey: string;
  items: unknown;
  note: string | null;
  createdAt: Date;
}

export interface NewFavorite {
  title: string;
  wearer?: string;
  bodyModelId?: string;
  note?: string;
  items: StoredItem[];
  image: Buffer;
}

export class SaveFavoriteDto {
  @IsUUID() sessionId: string;
  @IsOptional() @IsString() @MaxLength(80) title?: string;
  @IsOptional() @IsString() @MaxLength(30) wearer?: string;
}

export const favoriteImageKey = (userId: string, id: string) => `saved/favorites/${userId}/${id}.png`;

export function toDto(row: FavoriteRow, garments: Map<string, GarmentItem>): FavoriteOutfit {
  const items = (row.items as StoredItem[]).flatMap((i): FavoriteOutfitItem[] => {
    const garment = garments.get(i.garmentId);
    return garment ? [{ garment, size: i.size, ...(i.recommendedSize ? { recommendedSize: i.recommendedSize } : {}) }] : [];
  });
  return {
    id: row.id,
    title: row.title,
    ...(row.wearer ? { wearer: row.wearer } : {}),
    ...(row.note ? { note: row.note } : {}),
    imageUrl: `/api/favorites/${row.id}/image`,
    items,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly catalog: CatalogRepository,
    private readonly sessions: TryOnSessionRepository,
    private readonly sizes: RecommendedSizes,
  ) {}

  async list(userId: string): Promise<FavoriteOutfit[]> {
    const rows: FavoriteRow[] = await this.prisma.favoriteOutfit.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    const ids = [...new Set(rows.flatMap((r) => (r.items as StoredItem[]).map((i) => i.garmentId)))];
    const found = await Promise.all(ids.map((id) => this.catalog.findGarment(id)));
    const garments = new Map(found.filter((g): g is GarmentItem => !!g).map((g) => [g.id, g]));
    return rows.map((r) => toDto(r, garments));
  }

  /** Alta directa (también la usa el seed de la cuenta demo). La imagen va a saved/, fuera del TTL. */
  async create(userId: string, fav: NewFavorite): Promise<FavoriteRow> {
    const id = randomUUID();
    const imageKey = favoriteImageKey(userId, id);
    await this.storage.put(imageKey, fav.image, 'image/png');
    const items = fav.items.map(({ garmentId, size, recommendedSize }) => ({ garmentId, size, ...(recommendedSize ? { recommendedSize } : {}) }));
    return this.prisma.favoriteOutfit.create({
      data: { id, userId, title: fav.title, wearer: fav.wearer ?? null, bodyModelId: fav.bodyModelId ?? null, note: fav.note ?? null, imageKey, items },
    });
  }

  /** Guardar el resultado del probador: la imagen se copia (sobrevive al TTL de la sesión). */
  async saveFromSession(userId: string, dto: SaveFavoriteDto, requester: Requester): Promise<FavoriteOutfit> {
    const session = await this.sessions.findOwned(dto.sessionId, requester);
    if (!session) throw new NotFoundException();
    if (session.status !== 'done' || !session.resultKey) throw new BadRequestException('la prueba con IA aún no tiene resultado');
    const image = await this.storage.getBuffer(session.resultKey);
    if (!image) throw new BadRequestException('el resultado ya no está disponible');
    const outfit = session.snapshot.outfit ?? [{ garmentId: session.garmentId, size: '' }];
    const found = await Promise.all(outfit.map((o) => this.catalog.findGarment(o.garmentId)));
    const garments = found.filter((g): g is GarmentItem => !!g);
    const recommended = await this.sizes.forUser(userId, garments);
    const title = dto.title?.trim() || garments.map((g) => g.name).join(' + ').slice(0, 80);
    const row = await this.create(userId, {
      title,
      wearer: dto.wearer?.trim() || undefined,
      bodyModelId: session.snapshot.bodyModelId,
      // Sin talla elegida, la IA probó la recomendada para el perfil.
      items: outfit.map((o) => ({ ...o, size: o.size || recommended.get(o.garmentId) || '', recommendedSize: recommended.get(o.garmentId) })),
      image,
    });
    return toDto(row, new Map(garments.map((g) => [g.id, g])));
  }

  async image(userId: string, id: string) {
    const row = await this.prisma.favoriteOutfit.findFirst({ where: { id, userId } });
    const obj = row ? await this.storage.get(row.imageKey) : null;
    if (!obj) throw new NotFoundException();
    return obj;
  }

  async remove(userId: string, id: string): Promise<{ deleted: boolean }> {
    const row = await this.prisma.favoriteOutfit.findFirst({ where: { id, userId } });
    if (!row) return { deleted: false };
    await this.storage.deleteMany([row.imageKey]);
    await this.prisma.favoriteOutfit.delete({ where: { id } });
    return { deleted: true };
  }
}

@UseGuards(AuthGuard)
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  async list(@CurrentRequester() r: Requester) {
    return { favorites: await this.favorites.list(r.userId!) };
  }

  @Post()
  save(@CurrentRequester() r: Requester, @Body() dto: SaveFavoriteDto) {
    return this.favorites.saveFromSession(r.userId!, dto, r);
  }

  @Get(':id/image')
  async image(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester, @Res() res: Response) {
    const obj = await this.favorites.image(r.userId!, id);
    res.setHeader('Content-Type', obj.contentType ?? 'image/png');
    // Imagen de una persona: nunca en caché compartida ni del service worker.
    res.setHeader('Cache-Control', 'private, no-store');
    obj.body.pipe(res);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentRequester() r: Requester) {
    return this.favorites.remove(r.userId!, id);
  }
}

@Module({
  imports: [CatalogModule, TryOnSessionsPersistenceModule, TryOnModule],
  controllers: [FavoritesController],
  providers: [FavoritesService],
  exports: [FavoritesService],
})
export class FavoritesModule {}
