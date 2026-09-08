// KyberSwap Aggregator (Robinhood Chain destekli): herhangi bir token icin en iyi rotayi bulur ve calldata uretir.
// USDG / GLD karsiligi PONS havuzlari, cok atlamali rotalar dahil. Relay ve Fomo da ayni router'i kullanir.
// API: GET /routes (kota + routeSummary) -> POST /route/build (calldata). Native ETH adresi 0xEeee...
import { ethers } from 'ethers';
import { ADDR } from '../constants.js';
import { sleep, type Chain } from '../rpc.js';
import type { Route } from '../types.js';
import type { Venue, TxPlan, PrepStep } from './types.js';
import { log } from '../logger.js';

const API = 'https://aggregator-api.kyberswap.com/robinhood/api/v1';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const HEADERS = { 'x-client-id': 'hood-copytrade-bot', 'content-type': 'application/json' };
const QUOTE_TTL_MS = 4000;

interface Hop { exchange: string; poolType: string; pool: string; tokenIn: string; tokenOut: string; swapAmount: string; amountOut: string; }
interface RouteSummary { tokenIn: string; amountIn: string; amountInUsd: string; tokenOut: string; amountOut: string; amountOutUsd: string; gas: string; gasUsd: string; route: Hop[][]; routeID: string; checksum: string; timestamp: number; [k: string]: unknown; }
interface RouteResult { summary: RouteSummary; routerAddress: string; }

const cache = new Map<string, { at: number; r: RouteResult }>();
let lastCall = 0;
let inflight: Promise<unknown> = Promise.resolve();

// API cagrilarini sirala ve 200ms arayla gonder (public API hiz siniri)
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const p = inflight.then(async () => { const wait = 200 - (Date.now() - lastCall); if (wait > 0) await sleep(wait); lastCall = Date.now(); return fn(); });
  inflight = p.catch(() => undefined);
  return p;
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init?.headers ?? {}) }, signal: ctrl.signal });
    const j = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: T };
    if (!res.ok || (j.code !== undefined && j.code !== 0) || !j.data) throw new Error(`Kyber API: ${j.message || res.status}`);
    return j.data;
  } finally { clearTimeout(t); }
}

export async function getRoute(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteResult | null> {
  const key = `${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}|${amountIn}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < QUOTE_TTL_MS) return c.r;
  try {
    const data = await queued(() => http<{ routeSummary: RouteSummary; routerAddress: string }>(`${API}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true`));
    if (!data.routeSummary || BigInt(data.routeSummary.amountOut) === 0n) return null;
    const r = { summary: data.routeSummary, routerAddress: data.routerAddress };
    cache.set(key, { at: Date.now(), r });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return r;
  } catch (e) {
    const m = (e as Error).message;
    if (!/route not found|no route/i.test(m)) log.debug('kyber rota hatasi', m);
    return null;
  }
}

async function build(r: RouteResult, sender: string, minOut: bigint, deadline: number): Promise<{ to: string; data: string; value: bigint }> {
  const out = BigInt(r.summary.amountOut);
  const slippageBps = Math.min(2000, Math.max(10, Number(((out - minOut) * 10_000n) / out)));
  const data = await queued(() => http<{ data: string; routerAddress: string; transactionValue: string }>(`${API}/route/build`, {
    method: 'POST',
    body: JSON.stringify({ routeSummary: r.summary, sender, recipient: sender, slippageTolerance: slippageBps, deadline, source: 'hood-copytrade-bot', enableGasEstimation: false }),
  }));
  return { to: data.routerAddress, data: data.data, value: BigInt(data.transactionValue || '0') };
}

const exchangesOf = (s: RouteSummary) => [...new Set(s.route.flat().map((h) => h.exchange))].join('>');

// ---- Diger venue'lerin kullandigi yardimcilar: ETH <-> USDG bacagi ve ETH/USD fiyati ----
export const KYBER_NATIVE = NATIVE;
let ethUsdCache = { value: 0, at: 0 };
let ethUsdInflight: Promise<number> | null = null;
// 1 ETH kac USDG? (60 sn onbellek; hata olursa son bilinen deger, hic yoksa 0)
export async function ethUsdCached(): Promise<number> {
  if (Date.now() - ethUsdCache.at < 60_000 && ethUsdCache.value > 0) return ethUsdCache.value;
  if (ethUsdInflight) return ethUsdInflight;
  ethUsdInflight = (async () => {
    try { const r = await getRoute(NATIVE, ADDR.USDG, ethers.parseEther('1')); const v = r ? Number(r.summary.amountOut) / 1e6 : 0; if (v > 0) ethUsdCache = { value: v, at: Date.now() }; }
    catch (e) { log.debug('ETH/USD hatasi', (e as Error).message); }
    finally { ethUsdInflight = null; }
    return ethUsdCache.value;
  })();
  return ethUsdInflight;
}
export const ethUsdKnown = () => ethUsdCache.value;

export async function quoteEthToUsdg(ethIn: bigint): Promise<bigint> {
  const r = await getRoute(NATIVE, ADDR.USDG, ethIn);
  if (!r) throw new Error('Kyber: ETH->USDG rotasi yok');
  return BigInt(r.summary.amountOut);
}
export async function quoteUsdgToEth(usdgIn: bigint): Promise<bigint> {
  if (usdgIn <= 0n) return 0n;
  const r = await getRoute(ADDR.USDG, NATIVE, usdgIn);
  if (!r) throw new Error('Kyber: USDG->ETH rotasi yok');
  return BigInt(r.summary.amountOut);
}

// Herhangi bir karsi varlik icin ETH cevrimi. Birim fiyat 60 sn onbelleklenir; fiyat dongusu Kyber'i doldurmasin.
const unitPrice = new Map<string, { v: bigint; at: number }>(); // token -> 1 birim (10^dec) kac wei ETH
export async function tokenUnitPriceEth(token: string, decimals: number): Promise<bigint> {
  const k = token.toLowerCase();
  const c = unitPrice.get(k);
  if (c && Date.now() - c.at < 60_000) return c.v;
  const r = await getRoute(token, NATIVE, 10n ** BigInt(decimals));
  if (!r) throw new Error(`Kyber: ${token.slice(0, 10)} -> ETH fiyati yok`);
  const v = BigInt(r.summary.amountOut);
  unitPrice.set(k, { v, at: Date.now() });
  return v;
}
// Karsi varlik miktari -> wei (yaklasik, onbellekli birim fiyatla)
export async function quoteAmountToEth(token: string, decimals: number, amount: bigint): Promise<bigint> {
  if (amount <= 0n) return 0n;
  const p = await tokenUnitPriceEth(token, decimals);
  return (amount * p) / 10n ** BigInt(decimals);
}
// wei -> karsi varlik miktari (yaklasik)
export async function ethToQuoteAmount(token: string, decimals: number, ethWei: bigint): Promise<bigint> {
  if (ethWei <= 0n) return 0n;
  const p = await tokenUnitPriceEth(token, decimals);
  if (p === 0n) throw new Error('Kyber: karsi varlik fiyati 0');
  return (ethWei * 10n ** BigInt(decimals)) / p;
}
// Gercek rota ile ETH -> karsi varlik kotasi (alim kurarken kullanilir)
export async function quoteEthToToken(token: string, ethIn: bigint): Promise<bigint> {
  const r = await getRoute(NATIVE, token, ethIn);
  if (!r) throw new Error(`Kyber: ETH -> ${token.slice(0, 10)} rotasi yok`);
  return BigInt(r.summary.amountOut);
}
export async function quoteTokenToEth(token: string, amountIn: bigint): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const r = await getRoute(token, NATIVE, amountIn);
  if (!r) throw new Error(`Kyber: ${token.slice(0, 10)} -> ETH rotasi yok`);
  return BigInt(r.summary.amountOut);
}
// Ayri bir islem olarak gonderilecek Kyber takasi (prep/post adimi): calldata + gerekli onay
export async function buildKyberLeg(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint, sender: string, deadline: number, label: string): Promise<PrepStep> {
  const r = await getRoute(tokenIn, tokenOut, amountIn);
  if (!r) throw new Error(`Kyber: ${label} rotasi yok`);
  const tx = await build(r, sender, minOut, deadline);
  const native = tokenIn.toLowerCase() === NATIVE.toLowerCase();
  return { kind: 'tx', label, to: tx.to, data: tx.data, value: native ? (tx.value || amountIn) : 0n, approvals: native ? [] : [{ kind: 'erc20', token: tokenIn, spender: tx.to, amount: amountIn }] };
}

export const kyber: Venue = {
  kind: 'kyber',

  async findRoutes(_chain, token) {
    const r = await getRoute(NATIVE, token, ethers.parseEther('0.005'));
    if (!r) return [];
    return [{ kind: 'kyber', token, label: `Kyber (${exchangesOf(r.summary)})`, pool: r.routerAddress }];
  },

  async quoteBuy(_chain, route, ethIn) {
    const r = await getRoute(NATIVE, route.token, ethIn);
    if (!r) throw new Error('Kyber: alim rotasi yok');
    return BigInt(r.summary.amountOut);
  },

  async quoteSell(_chain, route, tokensIn) {
    const r = await getRoute(route.token, NATIVE, tokensIn);
    if (!r) throw new Error('Kyber: satis rotasi yok');
    return BigInt(r.summary.amountOut);
  },

  // Aggregator rotasinda tek bir havuz derinligi yoktur; fiyat etkisinden turetilen tahmin cok gurultulu cikti
  // (sahte "likidite dustu" satislari). -1n = bilinmiyor: likidite kurali atlanir, alimlarda al-sat kaybi kontrolu koruma saglar.
  async liquidityEth(_chain, route) {
    const r = await getRoute(NATIVE, route.token, ethers.parseEther('0.005'));
    if (!r) throw new Error('Kyber: rota yok');
    return -1n;
  },

  poolFeePct: async () => 0, // ucretler kotaya dahil; tuzak havuzlar al-sat kaybi kontrolune takilir

  async buildBuy(chain, route, ethIn, minOut, _recipient, deadline): Promise<TxPlan> {
    const r = await getRoute(NATIVE, route.token, ethIn);
    if (!r) throw new Error('Kyber: alim rotasi yok');
    const tx = await build(r, chain.address, minOut, deadline);
    return { to: tx.to, data: tx.data, value: tx.value || ethIn, approvals: [], prep: [] };
  },

  async buildSell(chain, route, tokensIn, minOut, _recipient, deadline): Promise<TxPlan> {
    const r = await getRoute(route.token, NATIVE, tokensIn);
    if (!r) throw new Error('Kyber: satis rotasi yok');
    const tx = await build(r, chain.address, minOut, deadline);
    return { to: tx.to, data: tx.data, value: 0n, approvals: [{ kind: 'erc20', token: route.token, spender: tx.to, amount: tokensIn }], prep: [] };
  },
};
