# Ryder 2026 - Código fuente completo

Aplicación web estática sin compilar. No requiere Node, npm ni servidor.

## Cómo abrir
1. Descomprime la carpeta.
2. Abre `index.html` en Chrome, Edge o Firefox.
3. Opcional: abre la carpeta en VS Code y usa Live Server.

## Archivos
- `index.html`: estructura principal y pestañas.
- `css/styles.css`: diseño visual moderno.
- `js/app.js`: lógica Match Play, puntos, persistencia, exportar/importar JSON.
- `data/matches.js`: configuración editable de partidos.

## Lógica
Por cada hoyo:
- Menor golpe gana el hoyo.
- Tigers gana hoyo: suma +1 al diferencial.
- Firmas gana hoyo: resta -1 al diferencial.
- Empate del hoyo: no cambia.

Resultado:
- Diferencial 0: AS.
- Diferencial positivo: Tigers Up.
- Diferencial negativo: Tigers Dw.

Puntos:
- Tigers Up: Tigers 1, Firmas 0.
- Tigers Dw: Tigers 0, Firmas 1.
- AS: 0,5 y 0,5.

## Editar partidos
Abre `data/matches.js` y modifica el arreglo `window.RYDER_MATCHES`.

## Abrir con sincronizacion en tiempo real
1. Abre una terminal en esta carpeta.
2. Ejecuta `node server.js`.
3. En este PC abre `http://localhost:8767/`.
4. En otro dispositivo de la misma red abre `http://IP-DEL-PC:8767/`.

El PC actua como servidor central. Los golpes digitados en cualquier navegador conectado se reflejan en los demas al instante.

El estado compartido se guarda en `data/state.json`.

## Arquitectura de sincronizacion
- `server.js`: servidor local HTTP + WebSocket.
- `js/sync-adapter.js`: capa reemplazable de sincronizacion del frontend.
- `js/app.js`: logica visual y de Match Play.

Cuando exista un servidor en nube, se puede reemplazar `js/sync-adapter.js` para apuntar a Firebase, Supabase o una API propia sin reescribir la interfaz.
