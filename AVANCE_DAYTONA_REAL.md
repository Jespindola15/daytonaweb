# Prueba con Daytona USA original — 12 noviembre 2026

Se ejecutó `node tools/run-node.mjs ../game/daytona_usa/DAYTONA.EXE --max 150000000 --quiet-api` sobre la instalación real del usuario.

**Resultado verificado:** 51.328.864 instrucciones x86 del ejecutable original; carga correcta de `RES_USA.DLL`; creación de ventana, DirectDraw y 9 superficies, lectura de recursos y archivos, inicialización de DirectSound. **Todavía no hay imagen del juego ni carrera jugable**: 0 frames presentados.

**Bloqueo actual:** `USER32.DLL!CreateDialogParamA`, llamada desde 0x00411dc5 con recurso de diálogo 110 (`0x6e`) de `RES_USA.DLL` y procedimiento 0x00411dd0. Hay que interpretar plantillas RT_DIALOG, crear controles, implementar mensajes `WM_INITDIALOG` y gestionar el procedimiento de diálogo y sus APIs relacionadas. No es correcto simular que el diálogo existe devolviendo un valor cualquiera.

**Cambios introducidos en esta versión:** `GetProcessAffinityMask`, `SetPriorityClass`, `GetSystemDefaultLangID`, `GetLocaleInfoA` (parcial), `_lopen`, `_lclose`, `EnumWindows` (sin ventanas externas), `LoadMenuA` (recursos reales), `CharUpperBuffA`, `GetMenu`, `GetSubMenu` (parcial), `CheckMenuItem` (parcial), `EnableMenuItem` (parcial), `GetDesktopWindow`, `GetPixel` y `SetPixel` (GDI provisional), `acmMetrics` (PCM), `WINNLSEnableIME`.

**Advertencia:** varias funciones son implementaciones parciales y requieren pruebas de compatibilidad. El resultado no demuestra que Daytona sea jugable ni que los gráficos sean correctos. El prototipo sigue sin usar streaming ni emulación completa de Windows.

Los logs de la ejecución real están en `tests/logs/daytona_original_150m.log`.
