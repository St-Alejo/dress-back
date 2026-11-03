// Genera, poco a poco, las pruebas reales "prenda sobre modelo" que faltan en el catálogo.
// Los motores gratuitos tienen cuota diaria de GPU, así que el script es reanudable:
// salta los pares ya generados y se detiene en cuanto el motor responde que no tiene cupo.
//
// Uso (con la API levantada):
//   node apps/api/scripts/pregenerate-previews.mjs [--max 6] [--api http://localhost:3000/api]
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const API = option('--api', 'http://localhost:3000/api');
const MAX = Number(option('--max', '6'));
const WEARABLE = new Set(['top', 'bottom', 'dress', 'outerwear']);
// Sobre un modelo con vestido la IA no cambia solo arriba o abajo (aiCanDress en shared-types).
const aiCanDress = (body, garment) => !(body.onePiece && (garment.category === 'top' || garment.category === 'bottom'));
// El endpoint admite 6 peticiones por minuto.
const PAUSE_MS = 11_000;

const get = async (path) => {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const garments = (await get('/catalog/garments')).filter((g) => WEARABLE.has(g.category));
const bodies = await get('/catalog/body-models');

// Los tres modelos que la galería de la ficha enseña para una prenda (spreadBySize en el web):
// la talla más chica, una media y la más grande entre los modelos con pose.
const galleryPicks = (garment) => {
  const sizes = garment.sizeChart.map((s) => s.size);
  const rank = (b) => (sizes.indexOf(b.typicalSize) < 0 ? sizes.length : sizes.indexOf(b.typicalSize));
  const posed = bodies.filter((b) => b.pose && aiCanDress(b, garment)).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  if (posed.length <= 3) return new Set(posed.map((b) => b.id));
  return new Set([0, 1, 2].map((k) => posed[Math.round((k * (posed.length - 1)) / 2)].id));
};

// Primero los modelos de la galería de cada prenda (lo que más se ve). Después, por rondas de
// cobertura: las prendas con menos pruebas IA y en cada una un modelo distinto (rotando), para que
// una cuota diaria reparta "una prueba real" por prenda antes de repetir. Mientras tanto, la vista
// aproximada cubre al instante todas las combinaciones.
const have = new Map(garments.map((g) => [g.id, bodies.filter((b) => b.previewImages[g.id]).length]));
const pending = [];
garments.forEach((garment, gi) => {
  const picks = galleryPicks(garment);
  bodies.forEach((body, bi) => {
    if (body.previewImages[garment.id] || !aiCanDress(body, garment)) return;
    const turn = (bi - gi + bodies.length * garments.length) % bodies.length;
    const tier = picks.has(body.id) ? 0 : 1;
    pending.push({ garment, body, rank: tier * 1e9 + (have.get(garment.id) + turn) * 1000 + gi });
  });
});
pending.sort((a, b) => a.rank - b.rank);
console.log(`faltan ${pending.length} pruebas; se intentan ${Math.min(MAX, pending.length)}`);

let done = 0;
for (const { garment, body } of pending.slice(0, MAX)) {
  const started = Date.now();
  const res = await fetch(`${API}/tryon/model-previews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bodyModelId: body.id, garmentId: garment.id }),
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (res.status === 503) {
    console.log(`motor sin cupo o no disponible tras ${seconds} s: se detiene aquí. Vuelve a ejecutarlo más tarde.`);
    break;
  }
  if (!res.ok) {
    console.log(`✗ ${garment.name} · ${body.bodyTypeTag}: HTTP ${res.status}`);
  } else {
    done++;
    console.log(`✓ ${garment.name} · ${body.bodyTypeTag} (${seconds} s)`);
  }
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}
console.log(`generadas ${done}; quedan ${pending.length - done}`);
