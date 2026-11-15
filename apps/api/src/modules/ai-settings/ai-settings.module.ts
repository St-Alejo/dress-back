import { Body, Controller, Get, Global, HttpCode, Injectable, Logger, Module, Post, Put, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  AI_PROVIDERS,
  WORKER_HEADERS,
  type AiProvider,
  type AiProviderSettings,
  type GarmentSuggestion,
  type BodyEstimate,
  type PhotoCheck,
} from '@vestirse/shared-types';
import { AdminGuard } from '../../common/guards';
import { PrismaService } from '../../common/prisma.service';
import { SecretBox } from './secret-box';

/** Motores que funcionan sin clave: el mock y los Spaces de Hugging Face (anónimos o con el HF_TOKEN del worker). */
const KEYLESS: ReadonlySet<AiProvider> = new Set(['mock', 'hf-chain', 'hf-fashn', 'hf-leffa', 'hf-idm']);

/** Modelo por defecto por proveedor (se puede cambiar desde el panel). */
export const DEFAULT_MODEL: Record<AiProvider, string | undefined> = {
  mock: undefined,
  'hf-chain': undefined,
  'hf-fashn': undefined,
  'hf-leffa': undefined,
  'hf-idm': undefined,
  'fal-catvton': 'fal-ai/cat-vton',
  replicate: undefined,
};

/** Costo aproximado por imagen (USD) para mostrar al admin. Los Spaces son gratuitos pero con cuota diaria. */
export const APPROX_COST_USD: Record<AiProvider, number> = {
  mock: 0,
  'hf-chain': 0,
  'hf-fashn': 0,
  'hf-leffa': 0,
  'hf-idm': 0,
  'fal-catvton': 0.05,
  replicate: 0.05,
};

/** Credenciales resueltas: solo viven en memoria del proceso y viajan al worker por la red interna. */
export interface AiCredentials {
  provider: AiProvider;
  model?: string;
  apiKey?: string;
}

class UpdateAiSettingsDto {
  @IsIn(AI_PROVIDERS as AiProvider[]) provider: AiProvider;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  /** Vacío = mantener la clave actual; "-" = borrarla. */
  @IsOptional() @IsString() @MaxLength(400) apiKey?: string;
}

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.box = new SecretBox(config.getOrThrow('APP_ENCRYPTION_KEY'));
  }

  /** Vista pública para el panel: nunca incluye la clave, solo sus últimos 4 caracteres. */
  async getPublic(): Promise<AiProviderSettings> {
    const row = await this.prisma.aiSettings.findUnique({ where: { id: 'default' } });
    if (row && this.usable(row)) {
      return {
        provider: row.provider as AiProvider,
        model: row.model ?? DEFAULT_MODEL[row.provider as AiProvider],
        keyConfigured: !!row.encryptedKey,
        keyHint: row.keyLast4 ? `••••${row.keyLast4}` : undefined,
        lastTestOk: row.lastTestOk,
        updatedAt: row.updatedAt.toISOString(),
        source: 'database',
      };
    }
    const env = this.fromEnv();
    return {
      provider: env.provider,
      model: env.model,
      keyConfigured: !!env.apiKey,
      keyHint: env.apiKey ? `••••${env.apiKey.slice(-4)}` : undefined,
      lastTestOk: row?.lastTestOk ?? null,
      source: this.config.get('AI_PROVIDER') ? 'environment' : 'none',
    };
  }

  /** Uso interno (procesador de generación). La clave descifrada nunca se registra en logs. */
  async resolve(): Promise<AiCredentials> {
    const row = await this.prisma.aiSettings.findUnique({ where: { id: 'default' } });
    if (row && this.usable(row)) {
      const provider = row.provider as AiProvider;
      let apiKey: string | undefined;
      if (row.encryptedKey) {
        try {
          apiKey = this.box.open(row.encryptedKey);
        } catch {
          this.logger.error('no se pudo descifrar la clave de IA (¿cambió APP_ENCRYPTION_KEY?)');
        }
      }
      return { provider, model: row.model ?? DEFAULT_MODEL[provider], apiKey };
    }
    return this.fromEnv();
  }

  async update(dto: UpdateAiSettingsDto): Promise<AiProviderSettings> {
    const data: { provider: string; model: string | null; encryptedKey?: string | null; keyLast4?: string | null; lastTestOk: null } = {
      provider: dto.provider,
      model: dto.model?.trim() || null,
      lastTestOk: null,
    };
    const key = dto.apiKey?.trim();
    if (key === '-') {
      data.encryptedKey = null;
      data.keyLast4 = null;
    } else if (key) {
      data.encryptedKey = this.box.seal(key);
      data.keyLast4 = key.slice(-4);
    }
    await this.prisma.aiSettings.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
    return this.getPublic();
  }

  async recordTest(ok: boolean) {
    await this.prisma.aiSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', lastTestOk: ok },
      update: { lastTestOk: ok },
    });
  }

  /** Una fila guardada vale si su proveedor sigue existiendo y, si necesita clave, la tiene. */
  private usable(row: { provider: string; encryptedKey: string | null }): boolean {
    const provider = row.provider as AiProvider;
    return AI_PROVIDERS.includes(provider) && (KEYLESS.has(provider) || !!row.encryptedKey);
  }

  private fromEnv(): AiCredentials {
    const provider = (this.config.get<string>('AI_PROVIDER') ?? 'mock') as AiProvider;
    const safe = AI_PROVIDERS.includes(provider) ? provider : 'mock';
    return { provider: safe, model: this.config.get('AI_MODEL') || DEFAULT_MODEL[safe], apiKey: this.config.get('AI_API_KEY') || undefined };
  }
}

/**
 * Cabeceras hacia el worker: credenciales del proveedor, token compartido y
 * correlación. Solo viajan por la red interna, nunca hacia el navegador.
 */
export function workerHeaders(c: AiCredentials, extra: { token?: string; requestId?: string } = {}): Record<string, string> {
  const h: Record<string, string> = { [WORKER_HEADERS.provider]: c.provider };
  if (c.model) h[WORKER_HEADERS.model] = c.model;
  if (c.apiKey) h[WORKER_HEADERS.key] = c.apiKey;
  if (extra.token) h[WORKER_HEADERS.token] = extra.token;
  if (extra.requestId) h[WORKER_HEADERS.requestId] = extra.requestId;
  return h;
}

/** Cliente mínimo del worker para operaciones de configuración. */
@Injectable()
export class AiWorkerClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow('AI_WORKER_URL');
    this.token = config.get<string>('WORKER_TOKEN') || undefined;
  }

  async test(c: AiCredentials): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/providers/test`, {
        method: 'POST',
        headers: workerHeaders(c, { token: this.token }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      return { ok: res.ok && body.ok === true, detail: body.detail };
    } catch {
      return { ok: false, detail: 'worker-unreachable' };
    }
  }

  /** Revisión del encuadre de la foto. Si el worker o Groq fallan, la foto se da por no revisada: nunca bloquea. */
  async inspectPhoto(image: Buffer): Promise<PhotoCheck> {
    const body = await this.postImage<PhotoCheck>('/v1/photo/inspect', image);
    return body && typeof body.ok === 'boolean' ? body : { checked: false, ok: true };
  }

  /** Sugerencias de etiquetado para el alta de una prenda; vacías si no hay análisis. */
  async describeGarment(image: Buffer): Promise<GarmentSuggestion> {
    const body = await this.postImage<{ suggestion?: GarmentSuggestion }>('/v1/garment/describe', image);
    return body?.suggestion ?? {};
  }

  /** Medidas estimadas para la talla (OpenAI si está configurado). Sin análisis devuelve `checked: false`. */
  async estimateBody(image: Buffer, heightCm: number): Promise<BodyEstimate> {
    type Raw = { checked?: boolean; usable?: boolean; reason?: BodyEstimate['reason']; confidence?: BodyEstimate['confidence'] } & Record<string, unknown>;
    const body = await this.postImage<Raw>('/v1/body/estimate', image, { heightCm: String(heightCm) });
    if (!body?.checked) return { checked: false, usable: false };
    if (!body.usable) return { checked: true, usable: false, reason: body.reason ?? null };
    const measurements: NonNullable<BodyEstimate['measurements']> = {};
    for (const key of ['chestCm', 'waistCm', 'hipCm', 'shoulderCm'] as const) {
      if (typeof body[key] === 'number') measurements[key] = body[key] as number;
    }
    return { checked: true, usable: true, reason: null, measurements, confidence: body.confidence ?? 'low' };
  }

  private async postImage<T>(path: string, image: Buffer, fields: Record<string, string> = {}): Promise<T | null> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'image.jpg');
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        body: form,
        headers: this.token ? { [WORKER_HEADERS.token]: this.token } : {},
        signal: AbortSignal.timeout(25_000),
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
}

@UseGuards(AdminGuard)
@Controller('admin/ai-settings')
export class AiSettingsController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly worker: AiWorkerClient,
  ) {}

  @Get()
  async get() {
    return { ...(await this.settings.getPublic()), approxCostUsd: APPROX_COST_USD, defaultModels: DEFAULT_MODEL };
  }

  @Put()
  update(@Body() dto: UpdateAiSettingsDto) {
    return this.settings.update(dto);
  }

  @Post('test')
  @HttpCode(200)
  async test() {
    const result = await this.worker.test(await this.settings.resolve());
    await this.settings.recordTest(result.ok);
    return result;
  }
}

@Global()
@Module({
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiWorkerClient],
  exports: [AiSettingsService, AiWorkerClient],
})
export class AiSettingsModule {}
