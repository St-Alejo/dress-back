import type { GarmentCategory, GarmentPhotoType, LetterSize } from '@vestirse/shared-types';
import { LETTER_BODY } from '../modules/catalog/domain/garment-grading';
import type { BodyShape } from '../modules/catalog/domain/body-geometry';
import type { GarmentStyle } from '../modules/catalog/domain/garment-style';

/**
 * Catálogo "cuerpo similar al mío" (sección 4, regla 4): cubre XS–4XL y
 * 150–195 cm desde el primer commit, con tonos de piel variados.
 * Las etiquetas son claves i18n descriptivas, nunca juicios.
 */
export interface SeedBody {
  key: string;
  bodyTypeTag: string;
  typicalSize: LetterSize;
  heightRange: [number, number];
  shape: BodyShape;
  skinTone: string;
  /** Su foto lleva vestido (ver aiCanDress en shared-types). */
  onePiece?: boolean;
  /** Su foto tiene las manos en los bolsillos (ver aiCanDress en shared-types). */
  handsInPockets?: boolean;
}

const SKIN = ['#F5D6C6', '#E8B998', '#D39B6F', '#A86B45', '#7D4A2D', '#4F2F1D'];

export const BODIES: SeedBody[] = [
  { key: 'b01', bodyTypeTag: 'petite-slim', typicalSize: 'XS', heightRange: [150, 158], shape: { heightCm: 154, shoulderCm: 36, chestCm: 80, waistCm: 63, hipCm: 86 }, skinTone: SKIN[1], onePiece: true },
  { key: 'b02', bodyTypeTag: 'petite-curvy', typicalSize: 'M', heightRange: [150, 160], shape: { heightCm: 156, shoulderCm: 38, chestCm: 96, waistCm: 77, hipCm: 104 }, skinTone: SKIN[3] },
  { key: 'b03', bodyTypeTag: 'average-straight', typicalSize: 'S', heightRange: [162, 170], shape: { heightCm: 166, shoulderCm: 40, chestCm: 87, waistCm: 72, hipCm: 91 }, skinTone: SKIN[5], onePiece: true },
  { key: 'b04', bodyTypeTag: 'average-curvy', typicalSize: 'L', heightRange: [160, 170], shape: { heightCm: 165, shoulderCm: 39, chestCm: 103, waistCm: 83, hipCm: 110 }, skinTone: SKIN[0] },
  { key: 'b05', bodyTypeTag: 'athletic', typicalSize: 'M', heightRange: [172, 180], shape: { heightCm: 176, shoulderCm: 46, chestCm: 98, waistCm: 78, hipCm: 95 }, skinTone: SKIN[2] },
  { key: 'b06', bodyTypeTag: 'average-broad', typicalSize: 'L', heightRange: [172, 182], shape: { heightCm: 177, shoulderCm: 47, chestCm: 106, waistCm: 92, hipCm: 103 }, skinTone: SKIN[2] },
  { key: 'b07', bodyTypeTag: 'tall-slim', typicalSize: 'M', heightRange: [180, 190], shape: { heightCm: 185, shoulderCm: 44, chestCm: 93, waistCm: 77, hipCm: 93 }, skinTone: SKIN[4], handsInPockets: true },
  { key: 'b08', bodyTypeTag: 'tall-broad', typicalSize: 'XL', heightRange: [184, 195], shape: { heightCm: 190, shoulderCm: 50, chestCm: 113, waistCm: 98, hipCm: 108 }, skinTone: SKIN[0] },
  { key: 'b09', bodyTypeTag: 'plus-hourglass', typicalSize: 'XXL', heightRange: [162, 172], shape: { heightCm: 167, shoulderCm: 42, chestCm: 120, waistCm: 100, hipCm: 124 }, skinTone: SKIN[4] },
  { key: 'b10', bodyTypeTag: 'plus-round', typicalSize: '3XL', heightRange: [168, 178], shape: { heightCm: 173, shoulderCm: 46, chestCm: 128, waistCm: 118, hipCm: 128 }, skinTone: SKIN[4] },
  { key: 'b11', bodyTypeTag: 'plus-tall', typicalSize: '4XL', heightRange: [180, 192], shape: { heightCm: 186, shoulderCm: 50, chestCm: 136, waistCm: 126, hipCm: 136 }, skinTone: SKIN[4] },
  { key: 'b12', bodyTypeTag: 'mid-soft', typicalSize: 'XL', heightRange: [165, 175], shape: { heightCm: 170, shoulderCm: 43, chestCm: 111, waistCm: 99, hipCm: 113 }, skinTone: SKIN[4] },
];

export interface SeedBrand {
  key: string;
  name: string;
  /** Correcciones históricas simuladas para demostrar la calibración por marca. */
  calibration?: { category: GarmentCategory; sampleSize: number; shiftSum: number }[];
}

export const BRANDS: SeedBrand[] = [
  { key: 'norte', name: 'Norte' },
  { key: 'lumbre', name: 'Lumbre', calibration: [{ category: 'top', sampleSize: 34, shiftSum: 26 }, { category: 'dress', sampleSize: 22, shiftSum: 15 }] },
  { key: 'brisa', name: 'Brisa', calibration: [{ category: 'outerwear', sampleSize: 28, shiftSum: -20 }] },
  { key: 'taller', name: 'Taller 12' },
];

type Range = [number, number];
export interface SeedSizeEntry {
  size: string;
  chest?: Range;
  waist?: Range;
  hip?: Range;
  height?: Range;
}

const LETTER = LETTER_BODY as Record<LetterSize, { chest: Range; waist: Range; hip: Range }>;
const ALL_LETTERS = Object.keys(LETTER) as LetterSize[];

/** Tabla detallada por tallas alfabéticas; `keys` elige qué medidas publica la marca. */
function letterChart(keys: ('chest' | 'waist' | 'hip')[], sizes: LetterSize[] = ALL_LETTERS): SeedSizeEntry[] {
  return sizes.map((size) => {
    const e: SeedSizeEntry = { size };
    for (const k of keys) e[k] = LETTER[size][k];
    return e;
  });
}
/** Tabla genérica sin medidas (solo nombres de talla): la confianza será media con altura. */
const genericLetters = (sizes: LetterSize[] = ALL_LETTERS): SeedSizeEntry[] => sizes.map((size) => ({ size }));
/** Tallas numéricas de pantalón con cintura/cadera. */
const numericBottoms = (): SeedSizeEntry[] =>
  [36, 38, 40, 42, 44, 46, 48, 50].map((n, i) => ({
    size: String(n),
    waist: [64 + i * 6, 69 + i * 6] as Range,
    hip: [88 + i * 6, 93 + i * 6] as Range,
  }));
const shoeSizes = (): SeedSizeEntry[] => ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'].map((size) => ({ size }));
const oneSize = (): SeedSizeEntry[] => [{ size: 'Única' }];

export interface SeedGarment {
  key: string;
  name: string;
  brand: string;
  category: GarmentCategory;
  style: GarmentStyle;
  color: string;
  /**
   * Cómo está fotografiada: sola (flat-lay) o extraída de una foto con persona por el segmentador
   * de ropa (extracted). En la tienda y en la cámara las dos se ven como la prenda sola.
   */
  photoType: GarmentPhotoType;
  priceCents: number;
  stretch: 'none' | 'low' | 'medium' | 'high';
  fabricNotes?: string;
  knownLimitations?: string[];
  sizeChart: SeedSizeEntry[];
}

export const GARMENTS: SeedGarment[] = [
  { key: 'g01', name: 'Camiseta básica blanca', brand: 'norte', category: 'top', style: 'tshirt', color: '#f2f1ee', photoType: 'flat-lay', priceCents: 1999, stretch: 'medium', fabricNotes: 'fabric.cottonJersey', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g02', name: 'Camiseta oversize rosa', brand: 'lumbre', category: 'top', style: 'tshirt', color: '#d9838a', photoType: 'flat-lay', priceCents: 2499, stretch: 'medium', fabricNotes: 'fabric.heavyCotton', knownLimitations: ['limitation.looseFit'], sizeChart: letterChart(['chest']) },
  { key: 'g03', name: 'Camiseta amarillo mantequilla', brand: 'brisa', category: 'top', style: 'tshirt', color: '#e2cf8f', photoType: 'flat-lay', priceCents: 2199, stretch: 'medium', fabricNotes: 'fabric.cottonJersey', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g04', name: 'Camiseta corta naranja', brand: 'taller', category: 'top', style: 'tshirt', color: '#e39a4f', photoType: 'flat-lay', priceCents: 2299, stretch: 'low', fabricNotes: 'fabric.heavyCotton', sizeChart: letterChart(['chest']) },
  { key: 'g05', name: 'Camiseta blanca de corte recto', brand: 'norte', category: 'top', style: 'tshirt', color: '#f4f3f0', photoType: 'flat-lay', priceCents: 2399, stretch: 'low', fabricNotes: 'fabric.heavyCotton', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g06', name: 'Camiseta corta blanca', brand: 'taller', category: 'top', style: 'tshirt', color: '#f3f3f1', photoType: 'flat-lay', priceCents: 2199, stretch: 'medium', fabricNotes: 'fabric.cottonJersey', sizeChart: letterChart(['chest']) },
  { key: 'g07', name: 'Camisa de lino cuello mao', brand: 'lumbre', category: 'top', style: 'shirt', color: '#f1eee8', photoType: 'flat-lay', priceCents: 4699, stretch: 'none', fabricNotes: 'fabric.linen', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g08', name: 'Camisa Oxford celeste', brand: 'norte', category: 'top', style: 'shirt', color: '#bcd3ea', photoType: 'flat-lay', priceCents: 4499, stretch: 'none', fabricNotes: 'fabric.oxfordNoStretch', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g09', name: 'Camisa de flores rojas', brand: 'taller', category: 'top', style: 'shirt', color: '#f3eef0', photoType: 'extracted', priceCents: 4899, stretch: 'none', knownLimitations: ['limitation.complexPattern'], sizeChart: genericLetters() },
  { key: 'g10', name: 'Blusa de leopardo', brand: 'lumbre', category: 'top', style: 'shirt', color: '#8a5a2b', photoType: 'extracted', priceCents: 4599, stretch: 'low', fabricNotes: 'fabric.viscoseFlowy', knownLimitations: ['limitation.complexPattern'], sizeChart: letterChart(['chest']) },
  { key: 'g11', name: 'Camiseta de rayas pastel', brand: 'brisa', category: 'top', style: 'tshirt', color: '#e9c9dc', photoType: 'extracted', priceCents: 2799, stretch: 'low', fabricNotes: 'fabric.cottonJersey', knownLimitations: ['limitation.complexPattern'], sizeChart: letterChart(['chest']) },
  { key: 'g12', name: 'Cárdigan rojo de punto', brand: 'lumbre', category: 'top', style: 'sweater', color: '#b01e2c', photoType: 'flat-lay', priceCents: 6499, stretch: 'medium', fabricNotes: 'fabric.knitRelaxed', sizeChart: letterChart(['chest']) },
  { key: 'g13', name: 'Suéter verde de cuello alto', brand: 'brisa', category: 'top', style: 'sweater', color: '#3f7a3a', photoType: 'extracted', priceCents: 5999, stretch: 'medium', fabricNotes: 'fabric.knitRelaxed', sizeChart: letterChart(['chest']) },
  { key: 'g14', name: 'Buzo con capucha rosa palo', brand: 'brisa', category: 'top', style: 'hoodie', color: '#c79a88', photoType: 'flat-lay', priceCents: 6499, stretch: 'medium', fabricNotes: 'fabric.fleeceOversize', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g15', name: 'Buzo con capucha blanco', brand: 'norte', category: 'top', style: 'hoodie', color: '#eef0f4', photoType: 'extracted', priceCents: 6299, stretch: 'medium', fabricNotes: 'fabric.fleeceOversize', sizeChart: letterChart(['chest', 'waist']) },
  { key: 'g16', name: 'Blazer beige', brand: 'norte', category: 'outerwear', style: 'jacket', color: '#cdb693', photoType: 'flat-lay', priceCents: 11999, stretch: 'none', sizeChart: letterChart(['chest']) },
  { key: 'g17', name: 'Blazer blanco cruzado', brand: 'lumbre', category: 'outerwear', style: 'jacket', color: '#f4f2ee', photoType: 'flat-lay', priceCents: 12999, stretch: 'none', sizeChart: letterChart(['chest']) },
  { key: 'g18', name: 'Blazer verde menta', brand: 'lumbre', category: 'outerwear', style: 'jacket', color: '#a9c9bb', photoType: 'flat-lay', priceCents: 11499, stretch: 'none', sizeChart: letterChart(['chest']) },
  { key: 'g19', name: 'Chaqueta vaquera con cuello de pana', brand: 'taller', category: 'outerwear', style: 'jacket', color: '#3c5d86', photoType: 'flat-lay', priceCents: 7999, stretch: 'low', sizeChart: letterChart(['chest']) },
  { key: 'g20', name: 'Chaqueta acolchada negra', brand: 'brisa', category: 'outerwear', style: 'coat', color: '#1c1c1e', photoType: 'flat-lay', priceCents: 14499, stretch: 'none', knownLimitations: ['limitation.looseFit'], sizeChart: letterChart(['chest', 'hip']) },
  { key: 'g21', name: 'Chaqueta de mezclilla', brand: 'norte', category: 'outerwear', style: 'jacket', color: '#4a6f9c', photoType: 'extracted', priceCents: 8999, stretch: 'none', fabricNotes: 'fabric.rigidDenim', sizeChart: letterChart(['chest']) },
  { key: 'g22', name: 'Chaqueta cortaviento negra', brand: 'brisa', category: 'outerwear', style: 'jacket', color: '#19191b', photoType: 'extracted', priceCents: 9499, stretch: 'low', sizeChart: letterChart(['chest']) },
  { key: 'g23', name: 'Blazer marrón', brand: 'taller', category: 'outerwear', style: 'jacket', color: '#8a6457', photoType: 'extracted', priceCents: 11999, stretch: 'none', sizeChart: letterChart(['chest']) },
  { key: 'g24', name: 'Jean pitillo oscuro', brand: 'taller', category: 'bottom', style: 'jeans', color: '#3b4f66', photoType: 'extracted', priceCents: 6999, stretch: 'medium', fabricNotes: 'fabric.denimLowStretch', sizeChart: numericBottoms() },
  { key: 'g25', name: 'Jean ancho claro', brand: 'lumbre', category: 'bottom', style: 'jeans', color: '#7fa6cf', photoType: 'extracted', priceCents: 7299, stretch: 'low', fabricNotes: 'fabric.denimLowStretch', knownLimitations: ['limitation.looseFit'], sizeChart: numericBottoms() },
  { key: 'g26', name: 'Jean pitillo rasgado', brand: 'taller', category: 'bottom', style: 'jeans', color: '#6f8fb0', photoType: 'extracted', priceCents: 6799, stretch: 'medium', fabricNotes: 'fabric.denimLowStretch', sizeChart: numericBottoms() },
  { key: 'g27', name: 'Jean mom con lazo', brand: 'norte', category: 'bottom', style: 'jeans', color: '#86a7c8', photoType: 'extracted', priceCents: 6999, stretch: 'low', fabricNotes: 'fabric.denimLowStretch', sizeChart: numericBottoms() },
  { key: 'g28', name: 'Pantalón pitillo amarillo', brand: 'lumbre', category: 'bottom', style: 'trousers', color: '#f0cf4f', photoType: 'extracted', priceCents: 5499, stretch: 'low', sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g29', name: 'Pantalón palazzo estampado', brand: 'lumbre', category: 'bottom', style: 'trousers', color: '#2f3229', photoType: 'extracted', priceCents: 5999, stretch: 'none', fabricNotes: 'fabric.viscoseFlowy', knownLimitations: ['limitation.complexPattern', 'limitation.looseFit'], sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g30', name: 'Pantalón de pana oliva', brand: 'brisa', category: 'bottom', style: 'trousers', color: '#6f7245', photoType: 'flat-lay', priceCents: 6499, stretch: 'none', sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g31', name: 'Jogger negro', brand: 'norte', category: 'bottom', style: 'trousers', color: '#1d1d20', photoType: 'extracted', priceCents: 4999, stretch: 'medium', knownLimitations: ['limitation.looseFit'], sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g32', name: 'Short de mezclilla', brand: 'brisa', category: 'bottom', style: 'shorts', color: '#6f93b8', photoType: 'extracted', priceCents: 3499, stretch: 'low', fabricNotes: 'fabric.denimLowStretch', sizeChart: letterChart(['waist']) },
  { key: 'g33', name: 'Falda corta blanca con botones', brand: 'norte', category: 'bottom', style: 'skirt', color: '#f1f0ed', photoType: 'extracted', priceCents: 3999, stretch: 'low', sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g34', name: 'Falda midi roja de lunares', brand: 'lumbre', category: 'bottom', style: 'skirt', color: '#a8242c', photoType: 'extracted', priceCents: 4999, stretch: 'none', fabricNotes: 'fabric.viscoseFlowy', knownLimitations: ['limitation.complexPattern'], sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g35', name: 'Falda lápiz blanca', brand: 'taller', category: 'bottom', style: 'skirt', color: '#f2f1ee', photoType: 'extracted', priceCents: 4499, stretch: 'low', sizeChart: letterChart(['waist', 'hip']) },
  { key: 'g36', name: 'Vestido rojo plisado', brand: 'lumbre', category: 'dress', style: 'dress-a', color: '#e01f3d', photoType: 'flat-lay', priceCents: 8499, stretch: 'low', fabricNotes: 'fabric.pleated', sizeChart: letterChart(['chest', 'waist', 'hip']) },
  { key: 'g37', name: 'Vestido floral de manga ancha', brand: 'brisa', category: 'dress', style: 'dress-a', color: '#e9e4ee', photoType: 'flat-lay', priceCents: 8999, stretch: 'none', fabricNotes: 'fabric.viscoseFlowy', knownLimitations: ['limitation.complexPattern', 'limitation.looseFit'], sizeChart: letterChart(['chest', 'waist', 'hip']) },
  { key: 'g38', name: 'Vestido túnica de cachemira', brand: 'lumbre', category: 'dress', style: 'dress-a', color: '#b9c6d9', photoType: 'flat-lay', priceCents: 9499, stretch: 'none', fabricNotes: 'fabric.viscoseFlowy', knownLimitations: ['limitation.complexPattern', 'limitation.looseFit'], sizeChart: letterChart(['chest', 'waist', 'hip']) },
  { key: 'g39', name: 'Vestido halter estampado', brand: 'taller', category: 'dress', style: 'dress-wrap', color: '#8f7a6a', photoType: 'flat-lay', priceCents: 7999, stretch: 'low', knownLimitations: ['limitation.complexPattern'], sizeChart: letterChart(['chest', 'waist', 'hip']) },
  { key: 'g40', name: 'Vestido negro de flores', brand: 'norte', category: 'dress', style: 'dress-a', color: '#22232b', photoType: 'flat-lay', priceCents: 8999, stretch: 'none', fabricNotes: 'fabric.viscoseFlowy', knownLimitations: ['limitation.complexPattern'], sizeChart: letterChart(['chest', 'waist', 'hip']) },
  { key: 'g41', name: 'Tenis blancos de cuero', brand: 'taller', category: 'footwear', style: 'sneakers', color: '#eeeeec', photoType: 'flat-lay', priceCents: 6999, stretch: 'none', sizeChart: shoeSizes() },
  { key: 'g42', name: 'Botines negros con hebilla', brand: 'norte', category: 'footwear', style: 'boots', color: '#2a2523', photoType: 'flat-lay', priceCents: 11499, stretch: 'none', sizeChart: shoeSizes() },
  { key: 'g43', name: 'Botines camel de tacón', brand: 'norte', category: 'footwear', style: 'boots', color: '#b96a2c', photoType: 'flat-lay', priceCents: 11999, stretch: 'none', sizeChart: shoeSizes() },
  { key: 'g44', name: 'Pañuelo de seda estampado', brand: 'brisa', category: 'accessory', style: 'scarf', color: '#e0662a', photoType: 'flat-lay', priceCents: 2499, stretch: 'low', sizeChart: oneSize() },
  { key: 'g45', name: 'Gorra negra', brand: 'taller', category: 'accessory', style: 'cap', color: '#1e2024', photoType: 'flat-lay', priceCents: 2199, stretch: 'low', sizeChart: oneSize() },
  { key: 'g46', name: 'Bolso de mano rojo', brand: 'lumbre', category: 'accessory', style: 'bag', color: '#9c1f2e', photoType: 'flat-lay', priceCents: 6999, stretch: 'none', sizeChart: oneSize() },
  { key: 'g47', name: 'Bolso satchel beige', brand: 'lumbre', category: 'accessory', style: 'bag', color: '#cdb9a8', photoType: 'flat-lay', priceCents: 7499, stretch: 'none', sizeChart: oneSize() },
];
