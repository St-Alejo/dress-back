from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuración del proceso. Las claves de los proveedores llegan por petición (X-AI-Key)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Secreto compartido con la API; vacío = sin autenticación (solo desarrollo local).
    worker_token: str = ""
    # Proveedor cuando la petición no trae X-AI-Provider.
    default_provider: str = "mock"
    mock_delay_seconds: float = 4.0
    max_upload_bytes: int = 10 * 1024 * 1024
    # El mismo valor que usa la API para abortar: el worker debe responder antes.
    generation_timeout_seconds: int = 240
    # Token gratuito de Hugging Face para los Spaces (vacío = anónimo, con menos cuota de GPU).
    hf_token: str = ""
    # Servidor de FASHN en una GPU propia (services/gpu-tryon). Si se define, `hf-chain` lo prueba primero.
    local_tryon_url: str = ""
    # Groq: visión para el control de calidad de la foto y el etiquetado de prendas.
    groq_api_key: str = ""
    groq_vision_model: str = "qwen/qwen3.8-27b"
    # "groq" (por defecto, gratuito), "claude" u "openai" (de pago; si fallan o no tienen saldo, caen a Groq).
    vision_provider: str = "groq"
    anthropic_api_key: str = ""
    claude_vision_model: str = "claude-haiku-5-5"
    # OpenAI (VISION_PROVIDER=openai, cae a Groq): además estima medidas para la talla.
    openai_api_key: str = ""
    openai_vision_model: str = "gpt-4.1-mini"
    # Tope de gasto acumulado (USD) y archivo donde se lleva la cuenta entre reinicios.
    openai_budget_usd: float = 0.20
    openai_spend_file: str = ".openai-spend.json"
    # Adaptadores heredados: se pueden configurar por entorno además de por cabecera.
    fal_key: str = ""
    fal_model: str = "fal-ai/cat-vton"
    replicate_api_token: str = ""
    replicate_model_version: str = ""
