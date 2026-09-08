import fs from 'node:fs';
import path from 'node:path';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', bold: '\x1b[1m' };
const LOG_DIR = path.resolve('logs');
let stream: fs.WriteStream | null = null;
let streamDay = '';

export interface LogLine { t: number; level: string; msg: string; }
const ring: LogLine[] = [];
const RING_MAX = 500;

const p2 = (n: number) => String(n).padStart(2, '0');
// Yerel saat (bilgisayarin saat dilimi), UTC degil
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

function fileStream(): fs.WriteStream {
  const day = localDay();
  if (!stream || streamDay !== day) {
    stream?.end();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, `bot-${day}.log`), { flags: 'a' });
    streamDay = day;
  }
  return stream;
}

const ts = () => { const d = new Date(); return `${localDay()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };

function safe(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return String(v); }
}

function emit(level: string, color: string, msg: string, extra?: unknown) {
  const tail = extra !== undefined ? ' ' + safe(extra) : '';
  console.log(`${C.dim}${ts()}${C.reset} ${color}${C.bold}[${level}]${C.reset} ${color}${msg}${C.reset}${C.dim}${tail}${C.reset}`);
  ring.push({ t: Date.now(), level, msg: msg + tail });
  if (ring.length > RING_MAX) ring.shift();
  try { fileStream().write(`${ts()} [${level}] ${msg}${tail}\n`); } catch { /* dosyaya yazilamazsa terminal yeterli */ }
}

export const log = {
  debug: (m: string, e?: unknown) => { if (process.env.DEBUG) emit('DBG', C.dim, m, e); },
  info: (m: string, e?: unknown) => emit('INFO', C.blue, m, e),
  ok: (m: string, e?: unknown) => emit('OK', C.green, m, e),
  warn: (m: string, e?: unknown) => emit('WARN', C.yellow, m, e),
  error: (m: string, e?: unknown) => emit('ERR', C.red, m, e instanceof Error ? e.message : e),
  signal: (m: string, e?: unknown) => emit('SIGNAL', C.cyan, m, e),
  trade: (m: string, e?: unknown) => emit('TRADE', C.magenta, m, e),
  recent: (n = 200): LogLine[] => ring.slice(-n),
};
