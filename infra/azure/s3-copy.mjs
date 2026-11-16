// Copia el bucket local (RustFS de docker compose) al S3 de la demo, sin uploads/ (fotos de personas
// con caducidad de 24 h). Uso: node s3-copy.mjs <endpoint-origen> <endpoint-destino>
// Credenciales: SRC_KEY/SRC_SECRET y DST_KEY/DST_SECRET; bucket: BUCKET (vestirse).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');

const [src, dst] = process.argv.slice(2);
const bucket = process.env.BUCKET ?? 'vestirse';
const client = (endpoint, k, s) => new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: k, secretAccessKey: s } });
const from = client(src, process.env.SRC_KEY, process.env.SRC_SECRET);
const to = client(dst, process.env.DST_KEY, process.env.DST_SECRET);

await to.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
let token;
let copied = 0;
let bytes = 0;
do {
  const page = await from.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
  for (const obj of page.Contents ?? []) {
    if (obj.Key.startsWith('uploads/')) continue;
    const res = await from.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
    const body = Buffer.from(await res.Body.transformToByteArray());
    await to.send(new PutObjectCommand({ Bucket: bucket, Key: obj.Key, Body: body, ContentType: res.ContentType }));
    copied++;
    bytes += body.length;
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);
console.log(`copiados ${copied} objetos (${(bytes / 1e6).toFixed(1)} MB)`);
