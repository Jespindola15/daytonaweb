# Daytona USA — avance comprobado de ejecución del EXE original

## Cambios
- Parser de recursos Win32 RT_DIALOG (plantillas estándar y extendidas), con lectura de título e IDs de controles y validación de límites.
- Implementación inicial de `CreateDialogParamA`, `WM_INITDIALOG`, `GetDlgItem`, `GetDlgCtrlID`, `SetDlgItemTextA`, `GetDlgItemTextA`, `EndDialog` y otras funciones USER32.
- Implementación inicial de `SendDlgItemMessageA` para mensajes de barras de progreso PBM_SETRANGE, PBM_SETPOS, PBM_DELTAPOS, PBM_SETSTEP y PBM_STEPIT.

## Prueba real
Comando ejecutado con la instalación original de Daytona:

`node tools/run-node.mjs <ruta>/DAYTONA.EXE --max 400000000 --quiet-api --frame frame.png`

Resultado: `estado=running`, 400.000.000 instrucciones, 1 frame presentado (negro). No hubo carrera jugable ni menú visible. Los diálogos originales 110 (Button Assign), 112 (Axis Assign) y 114 ([Daytona USA] Loading...) fueron reconocidos.

## Limitaciones
La emulación de ventanas y diálogos es parcial. El primer fotograma presentado es negro. No se ha verificado la jugabilidad, los controles en una carrera ni el multijugador. No se debe presentar esta compilación como un port terminado.

## Próximo objetivo
Diagnosticar por qué el juego presenta un frame negro: seguir las superficies de DirectDraw, Blt/BltFast, el buffer primario y el bucle de carga de recursos. Después conseguir un menú visible y controlable antes de intentar online.
