import { ethers } from 'ethers';
import { ADDR, CHAIN_ID } from './constants.js';
import { MULTICALL3_ABI } from './abis/uniswap.js';
import { log } from './logger.js';

export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const PUBLIC_RPCS = [PUBLIC_RPC, 'https://robinhood.drpc.org']; // genis log taramalari icin; resmi RPC Cloudflare 403 verirse dRPC
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Cevap veren ilk public RPC (resmi olan zaman zaman Cloudflare 403 doner)
export async function pickPublicProvider(): Promise<ethers.JsonRpcProvider> {
  for (const url of PUBLIC_RPCS) {
    const p = makeHttpProvider(url);
    try { await Promise.race([p.send('eth_chainId', []), new Promise((_, rej) => setTimeout(() => rej(new Error('zaman asimi')), 8000))]); return p; }
    catch (e) { log.warn(`public RPC cevap vermedi (${url}): ${(e as Error).message.slice(0, 80)}`); }
  }
  return makeHttpProvider(PUBLIC_RPC);
}
const mask = (u: string) => u.replace(/\/v2\/[^/?]+/, '/v2/***');

export interface Chain {
  provider: ethers.JsonRpcProvider;        // ana RPC (Alchemy veya public)
  publicProvider: ethers.JsonRpcProvider;  // genis blok araligi log taramalari icin her zaman public RPC
  simulateProvider?: ethers.JsonRpcProvider; // eth_simulateV1 destekleyen provider (ana veya public)
  httpUrl: string;
  wssUrl?: string;
  wss?: ethers.WebSocketProvider;
  wallet?: ethers.Wallet;
  address: string;           // islem cuzdani (paper modda key yoksa rastgele bos adres)
  multicall: ethers.Contract;
  supportsSimulate: boolean;
  isAlchemy: boolean;
}

export function makeHttpProvider(url: string): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(url);
  req.timeout = 20_000;
  // HTTP 429'da ethers sessizce uzun sure bekleyip tekrar dener; bunu kisa tutup kontrolu withRetry'a birakiyoruz
  req.setThrottleParams({ slotInterval: 250, maxAttempts: 2 });
  return new ethers.JsonRpcProvider(req, CHAIN_ID, { staticNetwork: true, batchMaxCount: 8, batchStallTime: 5, polling: false });
}

async function probeSimulate(provider: ethers.JsonRpcProvider): Promise<boolean> {
  try {
    const r = await provider.send('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ to: ADDR.MULTICALL3, data: '0x' }] }], validation: false }, 'latest']);
    return Array.isArray(r);
  } catch { return false; }
}

export async function connect(opts: { httpUrl: string; wssUrl?: string; privateKey?: string }): Promise<Chain> {
  const provider = makeHttpProvider(opts.httpUrl);
  // Gercek baglanti testi: yanlis Alchemy anahtari/URL burada net bir hatayla yakalanir
  try {
    const chainIdHex = (await withRetry(() => provider.send('eth_chainId', []), 'rpc-check', 2)) as string;
    if (Number(chainIdHex) !== CHAIN_ID) throw new Error(`RPC yanlis zincire bagli: chainId ${Number(chainIdHex)}, beklenen ${CHAIN_ID} (Robinhood Chain)`);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/yanlis zincire/.test(msg)) throw e;
    throw new Error(`RPC'ye baglanilamadi (${mask(opts.httpUrl)}): ${msg.slice(0, 140)} -> Alchemy anahtari veya URL yanlis olabilir`);
  }
  const isPublic = PUBLIC_RPCS.includes(opts.httpUrl.replace(/\/$/, ''));
  const publicProvider = isPublic ? provider : await pickPublicProvider();

  let wss: ethers.WebSocketProvider | undefined;
  if (opts.wssUrl) {
    try {
      wss = new ethers.WebSocketProvider(opts.wssUrl, CHAIN_ID);
      await wss.getBlockNumber();
      log.ok(`WebSocket baglantisi kuruldu: ${mask(opts.wssUrl)}`);
    } catch (e) {
      log.warn(`WebSocket baglanamadi, HTTP polling ile devam: ${(e as Error).message}`);
      wss = undefined;
    }
  }

  const wallet = opts.privateKey ? new ethers.Wallet(opts.privateKey, provider) : undefined;
  const address = wallet ? wallet.address : ethers.Wallet.createRandom().address; // paper: bos, rastgele adres (simulasyonlar bunu kullanir)
  const multicall = new ethers.Contract(ADDR.MULTICALL3, MULTICALL3_ABI, provider);

  let simulateProvider: ethers.JsonRpcProvider | undefined;
  if (await probeSimulate(provider)) simulateProvider = provider;
  else if (!isPublic && (await probeSimulate(publicProvider))) simulateProvider = publicProvider;

  return { provider, publicProvider, simulateProvider, httpUrl: opts.httpUrl, wssUrl: opts.wssUrl, wss, wallet, address, multicall, supportsSimulate: !!simulateProvider, isAlchemy: opts.httpUrl.includes('alchemy.com') };
}

const RATE_LIMIT = /429|too many/i;
const TRANSIENT = /timeout|timed out|econnreset|etimedout|socket hang up|network_error|server_error|fetch failed|bad response|502|503|504/i;
let lastRateWarn = 0;
export const rateLimitStats = { hits: 0 };

export function isRateLimit(e: unknown): boolean {
  const err = e as { message?: string; code?: string; shortMessage?: string; info?: { error?: { code?: number } } };
  return RATE_LIMIT.test(`${err?.code ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''}`) || err?.info?.error?.code === 429;
}

// Alchemy free tier: eth_getLogs en fazla 10 bloklik aralik
export function isLogRangeLimit(e: unknown): boolean {
  const err = e as { message?: string; info?: { error?: { message?: string } } };
  return /free tier|block range|10 block|exceeds limit|limit of 10000/i.test(`${err?.message ?? ''} ${err?.info?.error?.message ?? ''}`);
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const err = e as { message?: string; code?: string; shortMessage?: string };
      const text = `${err.code ?? ''} ${err.shortMessage ?? ''} ${err.message ?? ''}`;
      const limited = isRateLimit(e);
      if ((!limited && !TRANSIENT.test(text)) || i === attempts - 1) throw e;
      const wait = (limited ? 1000 : 400) * 2 ** i + Math.floor(Math.random() * 300);
      if (limited) {
        rateLimitStats.hits++;
        if (Date.now() - lastRateWarn > 30_000) { lastRateWarn = Date.now(); log.warn(`RPC hiz siniri (429) - ${label} ${wait}ms sonra tekrar denenecek.`); }
      } else log.debug(`${label}: gecici RPC hatasi, ${wait}ms sonra tekrar (${i + 1}/${attempts})`, err.shortMessage ?? err.message);
      await sleep(wait);
    }
  }
  throw last;
}

// Public RPC'de genis blok araligi log taramalari sirayla yapilir: es zamanli taramalar 429 firtinasi ve dakikalarca gecikme yaratiyordu
let scanQueue: Promise<unknown> = Promise.resolve();
export function publicScan<T>(fn: () => Promise<T>): Promise<T> {
  const p = scanQueue.then(fn, fn);
  scanQueue = p.catch(() => undefined);
  return p;
}

export interface MulticallItem { target: string; iface: ethers.Interface; fn: string; args?: unknown[]; }

// Multicall3.aggregate3 ile tek RPC cagrisinda cok sayida okuma. Basarisiz olanlar null doner.
export async function multicall(chain: Chain, items: MulticallItem[]): Promise<(ethers.Result | null)[]> {
  if (items.length === 0) return [];
  const calls = items.map((it) => ({ target: it.target, allowFailure: true, callData: it.iface.encodeFunctionData(it.fn, it.args ?? []) }));
  const res = (await withRetry(() => chain.multicall.aggregate3.staticCall(calls), 'multicall')) as { success: boolean; returnData: string }[];
  return res.map((r, i) => {
    if (!r.success || r.returnData === '0x') return null;
    try { return items[i].iface.decodeFunctionResult(items[i].fn, r.returnData); } catch { return null; }
  });
}

export interface SimCall { to: string; data: string; value?: bigint; from?: string; }
export interface SimResult { status: number; returnData: string; gasUsed: bigint; error?: string; logs: { address: string; topics: string[]; data: string }[]; }

export interface SimBlock { calls: SimCall[]; timeOffsetSec?: number; } // timeOffsetSec: bir onceki bloga gore zaman farki

// eth_simulateV1: islemleri ardisik sanal bloklarda calistirir (honeypot round-trip icin).
// Alim ve satisi ayri bloklara koymak "ayni blokta al-sat yasak" gibi anti-bot kurallarinin sahte honeypot alarmi vermesini onler.
export async function simulateBlocks(chain: Chain, from: string, blocks: SimBlock[], ethBalanceOverride?: bigint): Promise<SimResult[][]> {
  const provider = chain.simulateProvider ?? chain.provider;
  const stateOverrides: Record<string, { balance: string }> = {};
  if (ethBalanceOverride !== undefined) stateOverrides[from] = { balance: ethers.toQuantity(ethBalanceOverride) };
  let t = Math.floor(Date.now() / 1000) + 5;
  const body = {
    blockStateCalls: blocks.map((b, i) => {
      t += b.timeOffsetSec ?? 1;
      return {
        ...(i === 0 ? { stateOverrides } : {}),
        blockOverrides: { time: ethers.toQuantity(t) },
        calls: b.calls.map((c) => ({ from: c.from ?? from, to: c.to, data: c.data, value: c.value !== undefined ? ethers.toQuantity(c.value) : undefined })),
      };
    }),
    validation: false,
    traceTransfers: false,
  };
  const res = (await withRetry(() => provider.send('eth_simulateV1', [body, 'latest']), 'eth_simulateV1')) as { calls: { status: string; returnData: string; gasUsed: string; error?: { message?: string }; logs?: { address: string; topics: string[]; data: string }[] }[] }[];
  return (res ?? []).map((blk) => (blk.calls ?? []).map((c) => ({ status: Number(c.status), returnData: c.returnData, gasUsed: BigInt(c.gasUsed ?? '0x0'), error: c.error?.message, logs: c.logs ?? [] })));
}

export async function simulate(chain: Chain, from: string, calls: SimCall[], ethBalanceOverride?: bigint): Promise<SimResult[]> {
  const r = await simulateBlocks(chain, from, [{ calls }], ethBalanceOverride);
  return r[0] ?? [];
}

// Zincir saati: bilgisayar saati ileri/geri olabilir; sinyal yasi zincir zamanina gore olculur
export const chainClock = {
  skewSec: 0,          // bilgisayar - zincir (saniye)
  syncedAt: 0,
  now(): number { return Date.now() / 1000 - this.skewSec; },
  async sync(provider: ethers.JsonRpcProvider) {
    try {
      const b = await provider.getBlock('latest');
      if (!b || !b.timestamp) return;
      const skew = Date.now() / 1000 - b.timestamp;
      // Sacma olcumleri (bayat/bozuk blok: saatler-gunler fark) yok say; aksi halde sinyal yasi ve giris gecikmesi bozulur
      if (Math.abs(skew) > 600) { log.debug(`chainClock: supheli sapma ${Math.round(skew)} sn, yok sayildi`); return; }
      this.skewSec = Math.abs(skew) > 20 ? skew : 0; this.syncedAt = Date.now();
    } catch { /* bir sonraki denemede */ }
  },
};

export function topicAddress(topic: string): string { return ethers.getAddress('0x' + topic.slice(26)); }
export function padAddress(addr: string): string { return ethers.zeroPadValue(addr, 32).toLowerCase(); }
export const fmtEth = (wei: bigint, digits = 5) => Number(ethers.formatEther(wei)).toFixed(digits);
export const fmtTok = (wei: bigint, decimals: number, digits = 2) => Number(ethers.formatUnits(wei, decimals)).toLocaleString('en-US', { maximumFractionDigits: digits });
export const applySlippage = (amount: bigint, slippagePct: number) => (amount * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
export const pctOf = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 1_000_000n) / whole) / 10_000);
