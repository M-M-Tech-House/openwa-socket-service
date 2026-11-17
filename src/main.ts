import express, { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import { SocketManager } from './socket-manager';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3100', 10);
const API_SECRET = process.env.SOCKET_SERVICE_SECRET;
const socketManager = new SocketManager(process.env.DATA_DIR, process.env.WEBHOOK_URL);

// --- Liveness Probe (Sin autenticacion para monitores de salud y orquestadores) ---
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'openwa-socket-service',
    timestamp: new Date().toISOString(),
    activeSessions: socketManager.getActiveSessionsCount(),
  });
});

// --- Middleware de seguridad opcional ---
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!API_SECRET) {
    next();
    return;
  }
  const token = req.headers['x-socket-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token !== API_SECRET) {
    res.status(401).json({ error: 'Unauthorized: invalid socket service secret' });
    return;
  }
  next();
}

app.use(authMiddleware);

// --- Endpoints de Sesiones ---

app.get('/sessions/:id/status', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const status = socketManager.getSessionStatus(sessionId);
  res.json({
    sessionId,
    status: status.status,
    qrReady: status.status === 'qr_ready',
    authenticated: status.status === 'ready',
    lastError: status.lastError,
  });
});

app.post('/sessions/:id/start', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  try {
    const state = await socketManager.startSession(sessionId);
    res.json({
      sessionId,
      status: state.status,
      qrCode: state.qrCode,
    });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/sessions/:id/qr', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const state = socketManager.getSessionStatus(sessionId);
  if (state.status === 'qr_ready' && state.qrCode) {
    res.json({
      sessionId,
      status: state.status,
      qrCode: state.qrCode,
    });
  } else if (state.status === 'ready') {
    res.status(400).json({ error: 'Session is already authenticated' });
  } else {
    // If not started yet, trigger start
    const newState = await socketManager.startSession(sessionId);
    res.json({
      sessionId,
      status: newState.status,
      qrCode: newState.qrCode,
    });
  }
});

app.post('/sessions/:id/send-message', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const { to, text } = req.body;
  if (!to || !text) {
    res.status(400).json({ error: 'Missing "to" or "text" fields' });
    return;
  }

  try {
    const result = await socketManager.sendMessage(sessionId, to, { text });
    res.json({ success: true, messageId: result?.key?.id, timestamp: result?.messageTimestamp });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/sessions/:id/stop', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  await socketManager.stopSession(sessionId);
  res.json({ success: true, sessionId, status: 'disconnected' });
});

app.post('/sessions/:id/logout', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  await socketManager.logoutSession(sessionId);
  res.json({ success: true, sessionId, status: 'disconnected' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`openwa-socket-service listening on port ${PORT}`);
  console.log(`Liveness probe available at http://0.0.0.0:${PORT}/health`);
});

export { app, server };
