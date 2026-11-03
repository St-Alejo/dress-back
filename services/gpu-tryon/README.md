# gpu-tryon · FASHN VTON en una GPU propia

Servidor mínimo (`server.py`, solo biblioteca estándar) que corre
[FASHN VTON v1.5](https://github.com/fashn-AI/fashn-vton-1.5) (Apache-2.0) en la GPU de la máquina:
prueba virtual fotorrealista **sin cuota de Hugging Face** y sin Internet al generar.

El ai-worker lo usa como primer motor de `hf-chain` cuando `LOCAL_TRYON_URL` está definido; si no
responde, la cadena sigue con los Spaces gratuitos (FASHN → Leffa → IDM-VTON) como siempre.

## Requisitos

- GPU NVIDIA con ≥ 8 GB de VRAM (probado en RTX 4070 Laptop). En RTX 30xx/40xx corre en bfloat16.
- Python 3.10–3.13 y unos 5 GB de disco (PyTorch con CUDA + 2 GB de pesos).

## Instalación (una vez, fuera del repo)

```powershell
mkdir fashn-local; cd fashn-local
git clone https://github.com/fashn-AI/fashn-vton-1.5.git repo
python -m venv .venv
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python -m pip install -e repo
.venv\Scripts\python repo\scripts\download_weights.py --weights-dir .\weights
```

## Uso

```powershell
# 1. Servidor de GPU (deja el modelo cargado; ~20–40 s por imagen)
fashn-local\.venv\Scripts\python <ruta a este repo>\services\gpu-tryon\server.py --weights-dir fashn-local\weights

# 2. En services/ai-worker/.env
LOCAL_TRYON_URL=http://127.0.0.1:8020
```

Con la API en `AI_PROVIDER=hf-chain`, las pruebas «Con tu foto» y «Cuerpo similar» se generan en la GPU.
Comprobación rápida: `curl http://127.0.0.1:8020/health`.

Escucha solo en `127.0.0.1` por defecto: no lo expongas a Internet sin autenticación.
