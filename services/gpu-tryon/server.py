"""
Servidor local de prueba virtual con GPU: FASHN VTON v1.5 (Apache-2.0) en la propia máquina.

Sin cuota de Hugging Face ni Internet al generar. Corre en el entorno del paquete `fashn-vton`
(PyTorch con CUDA), separado del ai-worker, que lo llama por HTTP cuando LOCAL_TRYON_URL está
definido (ver README.md de esta carpeta). Solo usa la biblioteca estándar además de FASHN.

    python server.py --weights-dir ./weights [--port 8020]

POST /tryon   JSON {person, garment (base64), category, photoType, segmentationFree, wideCut, steps, seed} → image/png
GET  /health  200 cuando el modelo está cargado

Con wideCut, una prenda de abajo de corte ancho se genera segmentada y con dos semillas (wide_cut.py).
Tras generar, color_match.py acerca el tono de una prenda lisa al de su foto (FASHN a veces lo apaga).

Privacidad: las imágenes viven solo en memoria durante la petición; no se escribe nada a disco.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

from color_match import LABELS, match_garment_color
import wide_cut

MAX_BODY = 25 * 1024 * 1024
CATEGORIES = {"tops", "bottoms", "one-pieces"}
PHOTO_TYPES = {"flat-lay", "model"}


def _release_vram() -> float:
    """Devuelve al driver la memoria que PyTorch dejó reservada y da el pico de la petición (GB).

    Sin esto la caché crece imagen a imagen y, al pasar de la VRAM, Windows usa RAM compartida:
    cada imagen tarda el doble o el triple.
    """
    import torch

    if not torch.cuda.is_available():
        return 0.0
    peak = torch.cuda.max_memory_reserved() / 2**30
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    return peak


def _match_color(pipeline, person, garment, image, category: str):
    """Ajuste de tono con el mismo segmentador de personas que usa FASHN; si falla, la imagen tal cual."""
    try:
        from fashn_human_parser import LABELS_TO_IDS

        seg = pipeline.hp_model.predict(np.asarray(image.convert("RGB")))
        labels = tuple(LABELS_TO_IDS[label] for label in LABELS[category])
        return match_garment_color(person, garment, image, seg, labels)
    except Exception as exc:  # un ajuste cosmético nunca tumba la prueba
        return image, f"sin ajuste de color ({type(exc).__name__})"


def _hem_width(pipeline, image) -> float:
    from fashn_human_parser import LABELS_TO_IDS

    seg = pipeline.hp_model.predict(np.asarray(image.convert("RGB")))
    return wide_cut.hem_width(seg, tuple(LABELS_TO_IDS[label] for label in LABELS["bottoms"]))


def build_handler(pipeline, lock: threading.Lock):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:  # sin rutas ni cuerpos en el log
            pass

        def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, detail: str) -> None:
            self._send(status, json.dumps({"detail": detail}).encode())

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(200, b'{"status":"ok","engine":"fashn-vton-1.5"}')
            else:
                self._error(404, "no existe")

        def do_POST(self) -> None:
            if self.path != "/tryon":
                return self._error(404, "no existe")
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_BODY:
                return self._error(413, "cuerpo vacío o demasiado grande")
            try:
                req = json.loads(self.rfile.read(length))
                person = Image.open(io.BytesIO(base64.b64decode(req["person"]))).convert("RGB")
                garment = Image.open(io.BytesIO(base64.b64decode(req["garment"]))).convert("RGB")
                category = req["category"]
                photo_type = req.get("photoType", "flat-lay")
                if category not in CATEGORIES or photo_type not in PHOTO_TYPES:
                    raise ValueError("categoría o tipo de foto inválido")
            except Exception as exc:
                return self._error(400, f"petición inválida: {type(exc).__name__}")
            started = time.perf_counter()
            # Una GPU de portátil no da para dos difusiones a la vez: se atienden en fila.
            with lock:
                wide = bool(req.get("wideCut")) and category == "bottoms"
                run = lambda seed, segmentation_free, guidance: pipeline(
                    person_image=person,
                    garment_image=garment,
                    category=category,
                    garment_photo_type=photo_type,
                    num_timesteps=int(req.get("steps", 30)),
                    guidance_scale=guidance,
                    seed=seed,
                    segmentation_free=segmentation_free,
                ).images[0]
                note = ""
                try:
                    if wide:
                        candidates = [run(seed, False, wide_cut.GUIDANCE) for seed in wide_cut.SEEDS]
                        best, widths = wide_cut.pick_widest(candidates, lambda img: _hem_width(pipeline, img))
                        image, note = candidates[best], f"; corte ancho {'/'.join(f'{w:.2f}' for w in widths)}"
                    else:
                        image = run(int(req.get("seed", 42)), bool(req.get("segmentationFree", True)), 1.5)
                except Exception as exc:
                    return self._error(500, f"fallo del modelo: {type(exc).__name__}")
                finally:
                    peak = _release_vram()
                # Dentro de la fila: el segmentador es el del pipeline y comparte la GPU.
                image, color = _match_color(pipeline, person, garment, image, category)
            out = io.BytesIO()
            image.save(out, format="PNG")
            print(f"[gpu-tryon] {category} en {time.perf_counter() - started:.1f} s (pico VRAM {peak:.1f} GB; {color}{note})", flush=True)
            self._send(200, out.getvalue(), "image/png")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="FASHN VTON v1.5 en la GPU local")
    parser.add_argument("--weights-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8020)
    args = parser.parse_args()

    from fashn_vton import TryOnPipeline  # import tardío: --help no carga PyTorch

    print("[gpu-tryon] cargando el modelo…", flush=True)
    pipeline = TryOnPipeline(weights_dir=args.weights_dir)
    server = ThreadingHTTPServer((args.host, args.port), build_handler(pipeline, threading.Lock()))
    print(f"[gpu-tryon] listo en http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
