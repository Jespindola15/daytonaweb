// Netlify Function: API del gestor de salas en /api/rooms (estado en Netlify Blobs).
import { getStore } from '@netlify/blobs';
import { handleRequest } from '../../server/rooms-core.mjs';

const KEY = 'lobby';

function blobStore() {
  const store = getStore({ name: 'daytona-salas', consistency: 'strong' });
  return {
    async read() {
      const r = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async write(data, etag) {
      // escritura condicional: falla si otro cliente modificó el lobby desde nuestra lectura
      const res = etag ? await store.setJSON(KEY, data, { onlyIfMatch: etag }) : await store.setJSON(KEY, data, { onlyIfNew: true });
      return res.modified;
    },
  };
}

export default async (req) => handleRequest(req, blobStore());

export const config = { path: '/api/rooms' };
