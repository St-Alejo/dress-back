import type { Brand, GarmentCategory, GarmentItem, GarmentPhotoType, SimilarBodyModel } from '@vestirse/shared-types';

export interface GarmentFilter {
  category?: GarmentCategory;
  brandId?: string;
  q?: string;
  includeInactive?: boolean;
}

/** Puerto Repository (sección 10): el dominio no sabe dónde viven los datos. */
export abstract class CatalogRepository {
  abstract listGarments(filter: GarmentFilter): Promise<GarmentItem[]>;
  abstract findGarment(id: string): Promise<GarmentItem | null>;
  abstract listBrands(): Promise<Brand[]>;
  /** Modelos de cuerpo; si se pasa `garmentId`, `previewImages` trae solo esa prenda. */
  abstract listBodyModels(garmentId?: string): Promise<SimilarBodyModel[]>;
  /** Foto real de producto y cómo está tomada: lo que necesita el motor de prueba. */
  abstract garmentPhoto(id: string): Promise<{ key: string; photoType: GarmentPhotoType } | null>;
  /** Foto de un modelo de cuerpo y lo que en ella impide a la IA vestir ciertas prendas (ver aiCanDress). */
  abstract bodyModelPhoto(id: string): Promise<{ key: string; onePiece: boolean; handsInPockets: boolean } | null>;
  abstract findPreviewKey(bodyModelId: string, garmentId: string): Promise<string | null>;
  abstract savePreview(bodyModelId: string, garmentId: string, imageKey: string): Promise<void>;
}
