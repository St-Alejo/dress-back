# ADR 0004 · Perfil opcional con foto y medidas, y medidas estimadas con OpenAI

Fecha: 2026-11-15 · Estado: aceptado

## Contexto

Hasta ahora la talla salía solo de lo que la persona escribía (altura obligatoria; pecho, cintura y
cadera opcionales), las medidas nunca se guardaban y la foto se borraba a las 24 h. El usuario pidió:

- medir mejor a la persona con la API de OpenAI, en la cámara y con la foto;
- una cuenta con perfil (foto de la persona y medidas) que, al cambiar, actualice todo al instante;
- todo con un crédito de prueba de 1 USD.

## Decisión

1. **Perfil opcional con consentimiento explícito.** Tabla `BodyProfile` 1:1 con `User`. Solo se crea
   con `consent: true` (lo valida el DTO y lo comprueba `invariants.spec.ts`). Retirar el
   consentimiento (`DELETE /profile`) o borrar la cuenta borra la fila y la foto de verdad.
   El resto de la app no cambia: las fotos de las sesiones siguen expirando a las 24 h y `/fit/*` no
   guarda medidas.
2. **La foto del perfil vive en `saved/profiles/…`**, fuera del prefijo `uploads/` que el bucket borra
   a diario. Se limpia igual que las demás (`cleanPhoto`: orientación, sin EXIF, máx. 1024 px).
3. **OpenAI como proveedor de visión** (`VISION_PROVIDER=openai`, cadena OpenAI → Groq) con una tarea
   nueva, `estimate_body`: foto + altura declarada → pecho, cintura, cadera y hombros.
   - `gpt-4.1-mini`, imagen en detalle bajo y salida con esquema JSON: ~0,0005 USD por medición.
   - Valores fuera de rango se descartan; el prompt prohíbe juicios sobre el cuerpo.
   - `SpendMeter` acumula el gasto en un archivo del worker y corta al llegar a `OPENAI_BUDGET_USD`.
   - Caché por hash de la imagen y del texto: la misma foto con la misma altura se paga una vez.
4. **Lo escrito manda.** Las medidas estimadas solo rellenan huecos (`aiFields` recuerda cuáles son);
   el motor de tallas las pesa menos que la cinta métrica y da confianza media
   (`fit.basis.estimatedFromPhoto`).
5. **Nunca por fotograma.** En la cámara se mide con un solo fotograma, a petición.

## Consecuencias

- Sin `OPENAI_API_KEY` o con el tope agotado, todo sigue funcionando: la talla sale de la altura y de
  las medidas escritas.
- Medido contra 4 modelos del catálogo: error típico de 2–10 cm, suficiente para orientar la talla
  pero no para sustituir la cinta; por eso la confianza nunca sube a "alta" con medidas estimadas.
