# Salas online en Cloudflare

Un **Worker** con dos **Durable Objects**:

- `Sala`: uno por sala. Mantiene los WebSocket de los jugadores (2 a 6), sus lugares (0..5), el anfitrión,
  quién está listo, coordina la largada (todos reinician el juego → cada uno avisa al llegar a la grilla → la sala
  da una hora de largada común) y reenvía a todos los estados de los autos (20 por segundo por jugador).
- `Lobby`: índice de salas abiertas (lo actualizan las salas).

El Worker también puede servir el sitio entero (carpeta `../dist`), así que hay dos formas de publicarlo.

## Opción A — todo en Cloudflare (sitio + salas)

```sh
cd cloudflare
npm install
npx wrangler login          # una sola vez: abre el navegador para iniciar sesión en Cloudflare
npm run deploy              # arma ../dist (sitio + juego) y publica
```

Queda en `https://daytona-salas.<tu-usuario>.workers.dev/web/`. Las salas se usan desde el mismo sitio, sin
configurar nada (`web/config.js` con `SALAS_URL = ''`).

## Opción B — el sitio sigue en Netlify, las salas en Cloudflare

1. Igual que arriba: `npm install`, `npx wrangler login`, `npm run deploy`.
2. En `web/config.js` poné la dirección del Worker:
   `export const SALAS_URL = 'https://daytona-salas.<tu-usuario>.workers.dev';`
3. Push a GitHub → Netlify publica el sitio; las salas van a Cloudflare (el Worker acepta peticiones de cualquier
   origen y el WebSocket funciona entre dominios).

También se puede cambiar la dirección desde el panel de salas → «Servidor de salas» (queda guardada en ese navegador).

## Probar localmente

```sh
cd cloudflare && npm install && npm run dev        # http://127.0.0.1:8787/web/
node ../tests/salas_cf_test.mjs                     # 13 comprobaciones del protocolo con 6+1 clientes
node ../tests/chrome_online.mjs                     # 2 ventanas de Chrome con el juego, por la sala
```

`wrangler dev` usa `workerd`, el mismo runtime de Cloudflare, con Durable Objects locales.

## Costos

Durable Objects con almacenamiento SQLite están disponibles en el plan gratuito de Workers, con límites diarios
de peticiones y de tiempo. Una carrera de 6 jugadores genera unos 120 mensajes WebSocket por segundo hacia la sala.
Los límites y precios cambian: revisalos en la documentación de Cloudflare antes de abrir salas al público.
