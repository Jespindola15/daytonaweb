// config.js — configuración del sitio.
// SALAS_URL: dirección del Worker de Cloudflare con las salas online (ver cloudflare/README.md).
//  · Vacío: el mismo sitio (cuando todo se publica en Cloudflare con `npx wrangler deploy`).
//  · Si el sitio sigue en Netlify, poné acá la dirección del Worker, por ejemplo:
//      export const SALAS_URL = 'https://daytona-salas.TU-USUARIO.workers.dev';
//    (también se puede cambiar desde el panel de salas → «Servidor de salas»).
export const SALAS_URL = 'https://daytona-salas.inibag.workers.dev';

// ONLINE: false = el panel de salas online muestra «Próximamente» y no se conecta a ningún servidor
// (lo usa la versión para compartir: `npm run build:compartir`).
export const ONLINE = true;
