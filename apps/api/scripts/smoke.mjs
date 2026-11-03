// Prueba de humo de la API contra un despliegue real (local o producción).
//
//   node apps/api/scripts/smoke.mjs [base]            base por defecto: http://localhost:3000/api
//   node apps/api/scripts/smoke.mjs https://vestirse.vercel.app/api --generate
//
// Recorre salud, catálogo, medios, sesiones de prueba (con y sin foto), talla, reseñas, cuenta y
// las invariantes éticas visibles desde fuera. Crea una cuenta temporal y la borra al final.
// --generate además lanza una generación con IA (gasta cuota de GPU de Hugging Face).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:3000/api').replace(/\/$/, '');
const generate = args.includes('--generate');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cookies = new Map();
let passed = 0;
const failures = [];

async function call(method, path, { json, form, raw } = {}) {
  const headers = { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  let body;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(base + path, { method, headers, body, signal: AbortSignal.timeout(90_000) });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (v) cookies.set(k, v);
    else cookies.delete(k);
  }
  const type = res.headers.get('content-type') ?? '';
  const data = raw ? await res.arrayBuffer() : type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, type, data };
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  XX  ${name}: ${err.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log(`API: ${base}\n`);
let garments = [];
let bodies = [];
let session;

await check('salud: base de datos y Redis arriba, worker responde', async () => {
  const r = await call('GET', '/health');
  expect(r.status === 200, `HTTP ${r.status}`);
  expect(r.data.info?.database?.status === 'up', 'base de datos caída');
  expect(r.data.info?.redis?.status === 'up', 'Redis caído');
  expect(r.data.info?.aiWorker?.status === 'up', `worker: ${r.data.info?.aiWorker?.status ?? r.data.error?.aiWorker?.status}`);
});

await check('visitante anónimo recibe cookie sid', async () => {
  expect(cookies.has('sid'), 'sin cookie sid');
});

await check('catálogo: lista de prendas con foto', async () => {
  const r = await call('GET', '/catalog/garments');
  expect(r.status === 200 && Array.isArray(r.data), `HTTP ${r.status}`);
  garments = r.data;
  expect(garments.length >= 20, `solo ${garments.length} prendas`);
  expect(garments.every((g) => g.images?.photo), 'hay prendas sin foto');
});

await check('catálogo: filtro por categoría y búsqueda', async () => {
  const bottoms = await call('GET', '/catalog/garments?category=bottom');
  expect(bottoms.status === 200 && bottoms.data.length > 0, 'sin pantalones');
  expect(bottoms.data.every((g) => g.category === 'bottom'), 'el filtro deja pasar otras categorías');
  const bad = await call('GET', '/catalog/garments?category=nada');
  expect(bad.status === 400, `categoría inválida → HTTP ${bad.status}`);
});

await check('catálogo: ficha de prenda y 404 de una inexistente', async () => {
  const r = await call('GET', `/catalog/garments/${garments[0].id}`);
  expect(r.status === 200 && r.data.id === garments[0].id, `HTTP ${r.status}`);
  const missing = await call('GET', '/catalog/garments/00000000-0000-4000-8000-000000000000');
  expect(missing.status === 404, `HTTP ${missing.status}`);
  const notUuid = await call('GET', '/catalog/garments/abc');
  expect(notUuid.status === 400, `id no UUID → HTTP ${notUuid.status}`);
});

await check('catálogo: marcas', async () => {
  const r = await call('GET', '/catalog/brands');
  expect(r.status === 200 && r.data.length >= 1, `HTTP ${r.status}`);
});

await check('cuerpos diversos: ≥10 modelos de XS a 4XL', async () => {
  const r = await call('GET', '/catalog/body-models');
  expect(r.status === 200, `HTTP ${r.status}`);
  bodies = r.data;
  const sizes = new Set(bodies.map((b) => b.typicalSize));
  expect(bodies.length >= 10, `solo ${bodies.length} modelos`);
  expect(sizes.has('XS') && sizes.has('4XL'), `tallas: ${[...sizes].join(', ')}`);
});

await check('medios: la foto de una prenda se sirve como imagen', async () => {
  const url = garments[0].images.photo;
  const path = url.startsWith('/api') ? url.slice(4) : new URL(url, base).pathname.replace(/^\/api/, '');
  const r = await call('GET', path, { raw: true });
  expect(r.status === 200 && r.type.startsWith('image/'), `HTTP ${r.status} ${r.type}`);
  expect(r.data.byteLength > 1000, 'imagen vacía');
});

await check('prueba: sesión con cuerpo similar', async () => {
  const r = await call('POST', '/tryon/sessions', {
    json: { garmentId: garments[0].id, mode: 'similar-model', bodyModelId: bodies[0].id },
  });
  expect(r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  session = r.data;
  const again = await call('GET', `/tryon/sessions/${session.id}`);
  expect(again.status === 200, `leer sesión → HTTP ${again.status}`);
  const list = await call('GET', '/tryon/sessions');
  expect(list.data.some((s) => s.id === session.id), 'no aparece en mis sesiones');
});

await check('prueba: la foto nunca es obligatoria y exige el checklist de privacidad', async () => {
  expect(!session.uploadedPhotoUrl, 'la sesión nace con foto');
  const photo = new Blob([readFileSync(join(root, 'seed', 'photos', 'bodies', 'b05.jpg'))], { type: 'image/jpeg' });
  const noAck = new FormData();
  noAck.append('photo', photo, 'b05.jpg');
  const rejected = await call('POST', `/tryon/sessions/${session.id}/photo`, { form: noAck });
  expect(rejected.status === 400, `sin checklist → HTTP ${rejected.status}`);
});

await check('prueba: subir foto, verla y borrarla al momento', async () => {
  const mode = await call('PATCH', `/tryon/sessions/${session.id}/mode`, { json: { mode: 'photorealistic' } });
  expect(mode.status === 200, `cambiar modo → HTTP ${mode.status}`);
  const form = new FormData();
  form.append('privacyAcknowledged', 'true');
  form.append('photo', new Blob([readFileSync(join(root, 'seed', 'photos', 'bodies', 'b05.jpg'))], { type: 'image/jpeg' }), 'b05.jpg');
  const up = await call('POST', `/tryon/sessions/${session.id}/photo`, { form });
  expect(up.status === 201 || up.status === 200, `subir → HTTP ${up.status} ${JSON.stringify(up.data).slice(0, 160)}`);
  const seen = await call('GET', `/tryon/sessions/${session.id}/photo`, { raw: true });
  expect(seen.status === 200 && seen.type.startsWith('image/'), `ver foto → HTTP ${seen.status}`);
  if (generate) {
    const gen = await call('POST', `/tryon/sessions/${session.id}/generate`);
    expect(gen.status < 300, `generar → HTTP ${gen.status}`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await call('GET', `/tryon/sessions/${session.id}`);
      const st = s.data.generationStatus;
      if (['done', 'fallback', 'failed'].includes(st)) {
        const why = s.data.failureReason ? ` (${s.data.failureReason})` : '';
        console.log(`       generación: ${st}${why}${s.data.resultImageUrl ? ', con imagen' : ''}`);
        break;
      }
    }
  }
  const del = await call('DELETE', `/tryon/sessions/${session.id}/photo`);
  expect(del.status === 200 || del.status === 204, `borrar → HTTP ${del.status}`);
  const gone = await call('GET', `/tryon/sessions/${session.id}/photo`);
  expect(gone.status === 404, `tras borrar → HTTP ${gone.status}`);
});

await check('sesiones ajenas: otro visitante no ve la sesión', async () => {
  const mine = new Map(cookies);
  cookies.clear();
  const r = await call('GET', `/tryon/sessions/${session.id}`);
  for (const [k, v] of mine) cookies.set(k, v);
  expect(r.status === 404 || r.status === 403, `HTTP ${r.status}`);
});

await check('talla: recomendación con confianza explícita', async () => {
  const r = await call('POST', '/fit/estimate', {
    json: { garmentId: garments[0].id, measurements: { heightCm: 170, weightKg: 68, silhouette: 'neutral' } },
  });
  expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  const text = JSON.stringify(r.data);
  expect(/confidence/i.test(text), 'la recomendación no trae confianza');
  const bad = await call('POST', '/fit/estimate', { json: { garmentId: garments[0].id, measurements: { heightCm: 20 } } });
  expect(bad.status === 400, `altura absurda → HTTP ${bad.status}`);
});

await check('privacidad: política pública', async () => {
  const r = await call('GET', '/privacy/policy');
  expect(r.status === 200, `HTTP ${r.status}`);
});

await check('sin rutas de adelgazar ni de comparar usuarios', async () => {
  for (const p of ['/leaderboard', '/compare-users', '/body/slim', '/reshape']) {
    const r = await call('GET', p);
    expect(r.status === 404, `${p} → HTTP ${r.status}`);
  }
});

await check('admin cerrado a visitantes', async () => {
  for (const p of ['/admin/garments', '/admin/metrics', '/admin/ai-settings']) {
    const r = await call('GET', p);
    expect(r.status === 401 || r.status === 403, `${p} → HTTP ${r.status}`);
  }
});

const email = `smoke-${Date.now()}@example.com`;
await check('cuenta: registro, sesión, reseña, cierre y borrado', async () => {
  const reg = await call('POST', '/auth/register', { json: { email, password: 'prueba-humo-123' } });
  expect(reg.status === 201 || reg.status === 200, `registro → HTTP ${reg.status} ${JSON.stringify(reg.data).slice(0, 120)}`);
  const me = await call('GET', '/auth/me');
  expect(me.status === 200 && me.data.email === email, `me → HTTP ${me.status}`);
  const weak = await call('POST', '/auth/register', { json: { email: `x${email}`, password: 'corta' } });
  expect(weak.status === 400, `contraseña corta → HTTP ${weak.status}`);
  const review = await call('POST', '/reviews', {
    json: { garmentId: garments[0].id, sizeBought: 'M', feeling: 'true-to-size', zones: [] },
  });
  expect(review.status < 300 || review.status === 400, `reseña → HTTP ${review.status}`);
  await call('POST', '/auth/logout');
  const out = await call('GET', '/auth/me');
  expect(out.status === 401 || (out.status === 200 && !out.data?.email), `tras logout → HTTP ${out.status}`);
  const login = await call('POST', '/auth/login', { json: { email, password: 'prueba-humo-123' } });
  expect(login.status === 200 || login.status === 201, `login → HTTP ${login.status}`);
  const bad = await call('POST', '/auth/login', { json: { email, password: 'otra-clave-mala' } });
  expect(bad.status === 401, `clave mala → HTTP ${bad.status}`);
  const del = await call('DELETE', '/privacy/account');
  expect(del.status === 200, `borrar cuenta → HTTP ${del.status}`);
  const relogin = await call('POST', '/auth/login', { json: { email, password: 'prueba-humo-123' } });
  expect(relogin.status === 401, `cuenta borrada sigue entrando → HTTP ${relogin.status}`);
});

console.log(`\n${passed} ok, ${failures.length} fallos`);
process.exit(failures.length ? 1 : 0);
