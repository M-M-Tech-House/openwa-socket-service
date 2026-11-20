import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';

export interface SessionState {
  socket?: WASocket;
  status: 'disconnected' | 'qr_ready' | 'authenticating' | 'ready';
  qrCode?: string;
  phoneNumber?: string;
  lastError?: string;
}

const FALLBACK_WA_VERSION: [number, number, number] = [2, 3000, 1045340097];
const VERSION_TIMEOUT_MS = 5000;

function isValidWaVersion(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)
  );
}

async function resolveWaVersion(logger: pino.Logger): Promise<[number, number, number]> {
  const raw = process.env.BAILEYS_WA_VERSION?.trim();
  if (raw) {
    const parts = raw.split(/[.,]/).map(s => parseInt(s, 10));
    if (parts.length === 3 && isValidWaVersion(parts) && parts[0] === 2 && parts[1] >= 2000) {
      return parts;
    }
    logger.warn(`Invalid BAILEYS_WA_VERSION "${raw}"; ignoring`);
  }

  try {
    const result = await fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    } as RequestInit);
    if (result?.isLatest === true && isValidWaVersion(result.version)) {
      return result.version;
    }
    logger.warn(`fetchLatestWaWebVersion returned isLatest=false; using fallback`);
  } catch (err) {
    logger.warn(`fetchLatestWaWebVersion failed: ${String(err)}; using fallback`);
  }

  return FALLBACK_WA_VERSION;
}

export class SocketManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly dataDir: string;
  private readonly webhookUrl?: string;
  private readonly logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  constructor(dataDir?: string, webhookUrl?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data', 'sessions');
    this.webhookUrl = webhookUrl || process.env.WEBHOOK_URL;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  getActiveSessionsCount(): number {
    let count = 0;
    for (const state of this.sessions.values()) {
      if (state.status === 'ready') count++;
    }
    return count;
  }

  getSessionStatus(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    return { status: 'disconnected' };
  }

  async startSession(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.socket && existing.status === 'ready') {
      return existing;
    }

    const sessionDir = path.join(this.dataDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sessionState: SessionState = {
      status: 'authenticating',
    };
    this.sessions.set(sessionId, sessionState);

    const version = await resolveWaVersion(this.logger);
    this.logger.info(`Using WhatsApp Web version ${version.join('.')}`);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      version,
      logger: this.logger.child({ session: sessionId }) as any,
    });

    sessionState.socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionState.status = 'qr_ready';
        try {
          sessionState.qrCode = await QRCode.toDataURL(qr);
        } catch {
          sessionState.qrCode = qr;
        }
        this.emitWebhook(sessionId, 'qr', { qrCode: sessionState.qrCode });
      }

      if (connection === 'open') {
        sessionState.status = 'ready';
        sessionState.qrCode = undefined;
        this.logger.info(`Session ${sessionId} connected successfully`);
        this.emitWebhook(sessionId, 'ready', { status: 'ready' });
      }

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        sessionState.status = 'disconnected';
        sessionState.lastError = String(lastDisconnect?.error || 'Closed');
        this.logger.warn(`Session ${sessionId} closed. Reconnect: ${shouldReconnect}`);
        this.emitWebhook(sessionId, 'disconnected', { reason: sessionState.lastError });

        if (shouldReconnect) {
          setTimeout(() => void this.startSession(sessionId), 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          if (!msg.key.fromMe) {
            this.emitWebhook(sessionId, 'message', { message: msg });
          }
        }
      }
    });

    return sessionState;
  }

  async sendMessage(sessionId: string, to: string, content: { text: string }): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.socket || session.status !== 'ready') {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    return session.socket.sendMessage(jid, { text: content.text });
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.socket) {
      try {
        session.socket.end(undefined);
      } catch { }
      session.status = 'disconnected';
    }
  }

  async logoutSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.socket) {
      try {
        await session.socket.logout();
      } catch { }
      this.sessions.delete(sessionId);
    }
    const sessionDir = path.join(this.dataDir, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }

  private emitWebhook(sessionId: string, event: string, payload: unknown): void {
    if (!this.webhookUrl) return;
    fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Event': event,
      },
      body: JSON.stringify({ sessionId, event, payload, timestamp: Date.now() }),
    }).catch(err => {
      this.logger.warn(`Webhook delivery failed for session ${sessionId}: ${String(err)}`);
    });
  }
}
