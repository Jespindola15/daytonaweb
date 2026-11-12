// ACM: métrica de tamaño máximo de WAVEFORMATEX para formatos PCM.
// Los codecs comprimidos todavía no están implementados.
import { api } from './common.js';
const A = {
  acmMetrics: api(3, (emu, obj, metric, out) => {
    if (!out) return 5; // MMSYSERR_INVALPARAM
    if (metric === 0x32) { emu.mem.w32(out, 18); return 0; } // ACM_METRIC_MAX_SIZE_FORMAT
    emu.note(`ACM metric ${metric}: sin implementar`);
    return 8; // MMSYSERR_NOTSUPPORTED
  }),
};
export default A;
