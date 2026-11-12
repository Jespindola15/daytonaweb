// Lista las APIs implementadas por módulo (para el informe de cobertura)
import { MODULES } from '../src/emulator.js';
for (const [dll, mod] of Object.entries(MODULES)) {
  const names = Object.keys(mod).filter((k) => !k.startsWith('__')).sort();
  console.log(`${dll} (${names.length}): ${names.join(', ')}`);
}
