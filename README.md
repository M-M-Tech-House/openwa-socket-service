# openwa-socket-service

Microservicio ligero y desacoplado para mantener conexiones persistentes de WhatsApp con Baileys (WebSockets/TCP).

## Características
- Proceso Node.js continuo especializado en Baileys.
- Consumo mínimo de memoria (~80MB de RAM), sin navegadores ni Chromium.
- Diseñado para ejecutarse en plataformas con capa gratuita permanente (Koyeb, Hugging Face Spaces Docker, Render, Fly.io).
- Liveness probe en `/health`.
- Conecta con `openwa-service` vía API REST y Webhooks para despliegues con Vercel.

## Variables de Entorno
- `PORT`: Puerto HTTP (por defecto `3100`).
- `SOCKET_SERVICE_SECRET`: Secreto opcional para proteger los endpoints.
- `WEBHOOK_URL`: URL del webhook en `openwa-service` para notificar eventos.
- `DATA_DIR`: Directorio de persistencia de credenciales (por defecto `./data/sessions`).

## Ejecución
```bash
npm install
npm run build
npm start
```
