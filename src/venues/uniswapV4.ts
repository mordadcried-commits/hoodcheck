// Uniswap v4: havuzlar PoolManager icinde tek sozlesmede yasar; havuz "PoolKey" ile tanimlanir.
// Robinhood Chain'deki UniversalRouter degistirilmis: SWAP_EXACT_IN_SINGLE parametrelerinde fazladan
// "minHopPriceX36" alani bekler (kaynak: docs.bags.fm/robinhood/trade-tokens). Standart kodlama revert eder.
// Karsi varlik ETH / WETH veya USDG olabilir. USDG havuzlarinda ETH bacagi Kyber ile ayri bir islem olarak eklenir
// (alimda once ETH->USDG, satista sonra USDG->ETH); kotalar ve MC hesabi ETH cinsine cevrilir.
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { ADDR, TOPICS, V4_DYNAMIC_FEE_FLAG } from '../constants.js';
import { UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI, V4_STATE_VIEW_ABI } from '../abis/uniswap.js';
import { multicall, publicScan, withRetry, type Chain } from '../rpc.js';
import type { PoolKey, Route, SignalHints } from '../types.js';
import type { Venue, TxPlan } from './types.js';
import { bagsState } from './bags.js';
import { buildKyberLeg, KYBER_NATIVE, quoteAmountToEth, quoteEthToToken, quoteTokenToEth } from './kyber.js';
import { isQuoteToken, quoteSymbol } from './quoteTokens.js';
import { getTokenInfo } from '../tokens.js';
import { log } from '../logger.js';

export const PONS_V4_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'; // PONS v2: token dogrudan v4 havuzunda dogar (egri yok), LP protokolde kilitli

const coder = ethers.AbiCoder.defaultAbiCoder();
const stateViewIface = new ethers.Interface(V4_STATE_VIEW_ABI);
const urIface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
const USDG = ADDR.USDG.toLowerCase();
const WETH = ADDR.WETH.toLowerCase();
const POOL_FILE = path.resolve('data', 'pools.json');
const BAGS_TICK_SPACING = 60; // canli zincirde mezun bir tokenin poolId'si ile dogrulandi

export type UrVariant = 'robinhood' | 'standard';
let urVariant: UrVariant = 'robinhood';
export const getUrVariant = () => urVariant;
export const setUrVariant = (v: UrVariant) => { urVariant = v; };

// %10 ustu ucretli havuzlar tuzaktir (satista paranin cogunu yer); rota adayi olarak denenmez
const MAX_SANE_FEE = 100_000;
// Onbellekten en fazla kac ek havuz denenir (RPC hiz limitini korumak icin)
const MAX_EXTRA_POOLS = 5;
const poolCache = new Map<string, PoolKey>();
(function load() {
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')))) poolCache.set(k, v as PoolKey); } catch { /* ilk calistirma */ }
})();
function persistPools() {
  try { fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true }); fs.writeFileSync(POOL_FILE, JSON.stringify(Object.fromEntries(poolCache), null, 1)); } catch { /* yok say */ }
}
export const cachedPoolKeys = (): [string, PoolKey][] => [...poolCache.entries()];

// Initialize logundan havuz anahtarini onbellege al (izleyici WSS aboneligi ve baslangic isitmasi kullanir)
let persistTimer: NodeJS.Timeout | null = null;
export function rememberInitializeLog(l: { topics: readonly string[]; data: string }): PoolKey | null {
  if (l.topics.length !== 4) return null;
  try {
    const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
    const key: PoolKey = { currency0: ethers.getAddress('0x' + l.topics[2].slice(26)), currency1: ethers.getAddress('0x' + l.topics[3].slice(26)), fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: String(hooks) };
    const id = l.topics[1].toLowerCase();
    if (!poolCache.has(id)) {
      poolCache.set(id, key);
      if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; persistPools(); }, 5000);
    }
    return key;
  } catch { return null; }
}

// Baslangic: son N saatin tum v4 havuzlarini public RPC'den bir kez tara (KOL alimlarinda havuz kesfi RPC taramasiz olsun)
export async function warmPoolCache(chain: Chain, hours: number): Promise<number> {
  const head = await chain.publicProvider.getBlockNumber();
  const from = Math.max(0, head - Math.round(hours * 34_600));
  let n = 0;
  const scan = async (a: number, b: number): Promise<void> => {
    try {
      const logs = await chain.publicProvider.getLogs({ address: ADDR.UNI_V4_POOL_MANAGER, topics: [TOPICS.V4_INITIALIZE], fromBlock: a, toBlock: b });
      for (const l of logs) if (rememberInitializeLog(l)) n++;
    } catch (e) {
      const msg = (e as Error).message;
      if (/exceeds limit|too many|limit of|timed out|timeout|429/i.test(msg) && b - a >= 2000) { const mid = Math.floor((a + b) / 2); await new Promise((r) => setTimeout(r, 400)); await scan(a, mid); await scan(mid + 1, b); }
      else log.debug('v4 havuz isitma parcasi atlandi', msg.slice(0, 80));
    }
  };
  await publicScan(() => scan(from, head));
  persistPools();
  return n;
}

export function poolIdOf(k: PoolKey): string {
  return ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

export function bagsPoolKey(token: string, tickSpacing = BAGS_TICK_SPACING): PoolKey {
  const tokenIs0 = BigInt(token) < BigInt(ADDR.WETH);
  const t = ethers.getAddress(token);
  return { currency0: tokenIs0 ? t : ADDR.WETH, currency1: tokenIs0 ? ADDR.WETH : t, fee: V4_DYNAMIC_FEE_FLAG, tickSpacing, hooks: ADDR.BAGS_V4_HOOK };
}

// PoolId -> PoolKey: PoolManager'in Initialize olayini geriye dogru parca parca arar (sonuc onbellege alinir)
export async function resolvePoolKey(chain: Chain, poolId: string): Promise<PoolKey | null> {
  const id = poolId.toLowerCase();
  const cached = poolCache.get(id);
  if (cached) return cached;
  // Genis aralikli log taramasi: Alchemy free tier 10 blokla sinirli oldugu icin her zaman public RPC.
  // Taramalar sirayla yapilir (publicScan): ayni anda birden fazla token icin tarama 429 firtinasi yaratiyordu.
  const head = await chain.publicProvider.getBlockNumber();
  const chunks: [number, number][] = [];
  chunks.push([Math.max(0, head - 200_000), head]);
  const CHUNK = 1_000_000;
  for (let to = head - 200_001, i = 0; to > 0 && i < 70; to -= CHUNK + 1, i++) chunks.push([Math.max(0, to - CHUNK), to]);
  for (const [from, to] of chunks) {
    const logs = await publicScan(() => withRetry(() => chain.publicProvider.getLogs({ address: ADDR.UNI_V4_POOL_MANAGER, topics: [TOPICS.V4_INITIALIZE, id], fromBlock: from, toBlock: to }), 'v4.resolvePoolKey', 3));
    if (logs.length) {
      const l = logs[0];
      const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
      const key: PoolKey = {
        currency0: ethers.getAddress('0x' + l.topics[2].slice(26)), currency1: ethers.getAddress('0x' + l.topics[3].slice(26)),
        fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: String(hooks),
      };
      poolCache.set(id, key); persistPools();
      return key;
    }
  }
  return null;
}

type QuoteKind = 'eth' | 'weth' | 'token';
function quoteCurrency(key: PoolKey, token: string): { quote: string; quoteIs0: boolean; kind: QuoteKind } | null {
  const t = token.toLowerCase();
  const c0 = key.currency0.toLowerCase(), c1 = key.currency1.toLowerCase();
  const kindOf = (c: string): QuoteKind | null => (c === ADDR.ZERO ? 'eth' : c === WETH ? 'weth' : isQuoteToken(c) ? 'token' : null);
  const k1 = kindOf(c1), k0 = kindOf(c0);
  if (c0 === t && k1) return { quote: key.currency1, quoteIs0: false, kind: k1 };
  if (c1 === t && k0) return { quote: key.currency0, quoteIs0: true, kind: k0 };
  return null;
}
const isTokenQuoted = (route: Route) => !!route.quoteToken;
// Karsi varligin ondalik hanesi (USDG 6, hisse tokenleri 18)
async function quoteDecimals(chain: Chain, token: string): Promise<number> {
  try { return (await getTokenInfo(chain, token)).decimals; } catch { return 18; }
}

export function routeFromKey(token: string, key: PoolKey): Route | null {
  const q = quoteCurrency(key, token);
  if (!q) return null;
  const feeLabel = key.fee === V4_DYNAMIC_FEE_FLAG ? 'dinamik' : `${key.fee / 10_000}%`;
  const h = key.hooks.toLowerCase();
  const isBags = h === ADDR.BAGS_V4_HOOK.toLowerCase(), isPons = h === PONS_V4_HOOK;
  const hook = isBags ? 'hood.fun' : isPons ? 'PONS' : key.hooks === ADDR.ZERO ? 'hook yok' : key.hooks.slice(0, 8);
  const qLabel = q.kind === 'eth' ? 'ETH' : q.kind === 'weth' ? 'WETH' : quoteSymbol(q.quote);
  return { kind: 'v4', token, label: `Uniswap v4 ${feeLabel} (${hook}, ${qLabel})`, poolId: poolIdOf(key), poolKey: key, quoteIsNative: q.kind === 'eth', quoteToken: q.kind === 'token' ? ethers.getAddress(q.quote) : undefined, lpLocked: isBags || isPons || undefined };
}

export function encodeV4SwapInput(key: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint, inCur: string, outCur: string, variant: UrVariant = urVariant): string {
  const actions = ethers.solidityPacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
  const swap = variant === 'robinhood'
    ? coder.encode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'], [[keyTuple, zeroForOne, amountIn, minOut, 0n, '0x']])
    : coder.encode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'], [[keyTuple, zeroForOne, amountIn, minOut, '0x']]);
  const settle = coder.encode(['address', 'uint256'], [inCur, amountIn]);
  const take = coder.encode(['address', 'uint256'], [outCur, minOut]);
  return coder.encode(['bytes', 'bytes[]'], [actions, [swap, settle, take]]);
}

export function buildUrExecute(input: string, deadline: number): string {
  return urIface.encodeFunctionData('execute', ['0x10', [input], deadline]);
}

async function slot0AndLiquidity(chain: Chain, poolId: string) {
  const [s, l] = await multicall(chain, [
    { target: ADDR.UNI_V4_STATE_VIEW, iface: stateViewIface, fn: 'getSlot0', args: [poolId] },
    { target: ADDR.UNI_V4_STATE_VIEW, iface: stateViewIface, fn: 'getLiquidity', args: [poolId] },
  ]);
  return { sqrtPriceX96: s ? BigInt(s[0]) : 0n, lpFee: s ? Number(s[3]) : 0, liquidity: l ? BigInt(l[0]) : 0n };
}

// Karsi varlik miktari -> wei (Kyber birim fiyati, 60 sn onbellekli)
async function quoteToWei(chain: Chain, route: Route, amount: bigint): Promise<bigint> {
  const dec = await quoteDecimals(chain, route.quoteToken!);
  return quoteAmountToEth(route.quoteToken!, dec, amount);
}

// Anlik fiyat, karsi varligin en kucuk biriminden 1e18 token basina (ETH: wei, USDG: 6 ondalik). Ucret ve fiyat etkisi icermez.
export async function spotPriceQ(chain: Chain, route: Route): Promise<bigint> {
  const { sqrtPriceX96 } = await slot0AndLiquidity(chain, route.poolId!);
  if (sqrtPriceX96 === 0n) throw new Error('v4 havuz durumu okunamadi');
  const qc = quoteCurrency(route.poolKey!, route.token)!;
  // p1per0 = sqrtP^2 / 2^192 = currency1 / currency0
  return qc.quoteIs0 ? (10n ** 18n * Q192) / (sqrtPriceX96 * sqrtPriceX96) : (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192;
}

async function v4Quote(chain: Chain, route: Route, zeroForOne: boolean, exactAmount: bigint, label: string): Promise<bigint> {
  const q = new ethers.Contract(ADDR.UNI_V4_QUOTER, V4_QUOTER_ABI, chain.provider);
  const r = await withRetry(() => q.quoteExactInputSingle.staticCall({ poolKey: route.poolKey!, zeroForOne, exactAmount, hookData: '0x' }), label);
  return BigInt(r[0]);
}

export const uniswapV4: Venue = {
  kind: 'v4',

  async findRoutes(chain, token, hints?: SignalHints) {
    const routes = new Map<string, Route>();
    // 0) Sinyalin makbuzundaki Initialize olaylari: havuz anahtari hazir, RPC taramasi gerekmez (lansmanlarda anlik kesif)
    for (const key of hints?.v4PoolKeys ?? []) {
      const r = routeFromKey(token, key);
      if (!r) continue;
      const id = r.poolId!.toLowerCase();
      if (!poolCache.has(id)) { poolCache.set(id, key); persistPools(); }
      routes.set(id, r);
    }
    // 1) hood.fun'dan mezun token -> bilinen anahtar
    try {
      const st = await bagsState(chain, token);
      if (st?.migrated) {
        let key: PoolKey | null = bagsPoolKey(token);
        if (poolIdOf(key).toLowerCase() !== st.poolId.toLowerCase()) key = await resolvePoolKey(chain, st.poolId);
        if (key) { const r = routeFromKey(token, key); if (r) routes.set(r.poolId!.toLowerCase(), r); }
      }
    } catch (e) { log.debug('bagsState hatasi', (e as Error).message); }
    // 2) sinyaldeki havuz kimlikleri
    for (const pid of hints?.v4PoolIds ?? []) {
      if (routes.has(pid.toLowerCase())) continue;
      const key = await resolvePoolKey(chain, pid);
      if (!key) continue;
      const r = routeFromKey(token, key);
      if (r) routes.set(r.poolId!.toLowerCase(), r);
    }
    // 3) Onbellekteki DIGER havuzlar: bir tokenin gercek likit havuzu, sinyalin geldigi islemden
    //    baska bir islemde acilmis olabilir (QBE ornegi: lansman sinyali USDG'li tuzak havuzdan geldi,
    //    asil PONS/ETH havuzu 6 dk once acilmisti ve tamamen atlandi).
    //    Sadece makul ucretli (<= %10) havuzlar denenir; %80-99 ucretliler tuzaktir.
    const t = token.toLowerCase();
    const extra: { id: string; key: PoolKey; score: number }[] = [];
    for (const [id, key] of poolCache) {
      if (routes.has(id)) continue;
      if (key.currency0.toLowerCase() !== t && key.currency1.toLowerCase() !== t) continue;
      if (key.fee !== V4_DYNAMIC_FEE_FLAG && key.fee > MAX_SANE_FEE) continue;
      // Oncelik: launchpad hook'u olan (LP kilitli) ve dusuk ucretli havuzlar
      const hooked = key.hooks.toLowerCase() !== ADDR.ZERO ? 1000 : 0;
      extra.push({ id, key, score: hooked - Math.min(999, key.fee === V4_DYNAMIC_FEE_FLAG ? 0 : key.fee / 100) });
    }
    // RPC maliyeti sinirlanir: bazi tokenlerin 28 tuzak havuzu var, hepsini sorgulamak
    // hiz limitine takilip TUM rotalari dusuruyordu. En umutlu MAX_EXTRA_POOLS havuz denenir.
    extra.sort((a, b) => b.score - a.score);
    for (const e of extra.slice(0, MAX_EXTRA_POOLS)) {
      const r = routeFromKey(token, e.key);
      if (r) routes.set(e.id, r);
    }
    // Sadece likiditesi olan havuzlar (paralel kontrol: lansmanda her saniye onemli).
    // ONEMLI: okuma HATA verirse (RPC hiz siniri) rota ELENMEZ. Hatayi 0 likidite saymak,
    // saglam havuzlari sessizce atiyordu (06.09: 86 lansman "havuz bulunamadi" ile kacti).
    // Bilinmeyen likidite -1n ile isaretlenir; kota alinabiliyorsa zaten islem yapilir.
    const cand = [...routes.values()];
    const liqs = await Promise.all(cand.map((r) => slot0AndLiquidity(chain, r.poolId!).then((x) => x.liquidity).catch(() => -1n)));
    const usable = cand.filter((_, i) => liqs[i] !== 0n);
    if (usable.length < cand.length) log.debug(`v4: ${cand.length - usable.length} havuz likiditesiz oldugu icin elendi`);
    return usable;
  },

  async quoteBuy(chain, route, ethIn) {
    const qc = quoteCurrency(route.poolKey!, route.token)!;
    const amountIn = qc.kind === 'token' ? await quoteEthToToken(qc.quote, ethIn) : ethIn;
    return v4Quote(chain, route, qc.quoteIs0, amountIn, 'v4.quoteBuy');
  },

  async quoteSell(chain, route, tokensIn) {
    const qc = quoteCurrency(route.poolKey!, route.token)!;
    const out = await v4Quote(chain, route, !qc.quoteIs0, tokensIn, 'v4.quoteSell');
    return qc.kind === 'token' ? quoteTokenToEth(qc.quote, out) : out;
  },

  async liquidityEth(chain, route) {
    // Tam aralik varsayimiyla havuzun karsi varlik tarafi sanal rezervi: L*sqrtP/2^96 (karsi varlik currency1 ise) veya L*2^96/sqrtP
    const { sqrtPriceX96, liquidity } = await slot0AndLiquidity(chain, route.poolId!);
    if (sqrtPriceX96 === 0n) throw new Error('v4 havuz durumu okunamadi (slot0 bos)'); // okuma hatasi; 0 likidite degil
    if (liquidity === 0n) return 0n;
    const qc = quoteCurrency(route.poolKey!, route.token)!;
    const quoteSide = qc.quoteIs0 ? (liquidity * Q96) / sqrtPriceX96 : (liquidity * sqrtPriceX96) / Q96;
    return qc.kind === 'token' ? quoteToWei(chain, route, quoteSide) : quoteSide;
  },

  // Anlik fiyat (ETH / token, wei bazinda 1e18 olcekli): MC hesabi icin, ucret ve fiyat etkisi icermez
  async spotPriceEth(chain, route) {
    const pq = await spotPriceQ(chain, route);
    return isTokenQuoted(route) ? quoteToWei(chain, route, pq) : pq;
  },

  async poolFeePct(chain, route) {
    if (route.poolKey!.hooks.toLowerCase() === ADDR.BAGS_V4_HOOK.toLowerCase()) return 2;
    const { lpFee } = await slot0AndLiquidity(chain, route.poolId!);
    return lpFee / 10_000;
  },

  async buildBuy(chain, route, ethIn, minOut, _recipient, deadline): Promise<TxPlan> {
    const qc = quoteCurrency(route.poolKey!, route.token)!;
    if (qc.kind === 'token') {
      // 1) ETH -> karsi varlik (Kyber, ayri islem) 2) karsi varlik -> token (UniversalRouter v4). %1 pay: Kyber bacagi biraz eksik verirse v4 takasi yine gecsin
      const sym = quoteSymbol(qc.quote);
      const qOut = await quoteEthToToken(qc.quote, ethIn);
      const qIn = (qOut * 990n) / 1000n;
      const leg = await buildKyberLeg(KYBER_NATIVE, qc.quote, ethIn, qIn, chain.address, deadline, `ETH->${sym} (Kyber)`);
      const input = encodeV4SwapInput(route.poolKey!, qc.quoteIs0, qIn, minOut, qc.quote, route.token);
      return {
        to: ADDR.UNIVERSAL_ROUTER, data: buildUrExecute(input, deadline), value: 0n,
        approvals: [
          { kind: 'erc20', token: qc.quote, spender: ADDR.PERMIT2, amount: qIn },
          { kind: 'permit2', token: qc.quote, spender: ADDR.UNIVERSAL_ROUTER, amount: qIn },
        ],
        prep: [leg],
      };
    }
    const input = encodeV4SwapInput(route.poolKey!, qc.quoteIs0, ethIn, minOut, qc.quote, route.token);
    const native = qc.quote === ADDR.ZERO;
    return {
      to: ADDR.UNIVERSAL_ROUTER, data: buildUrExecute(input, deadline), value: native ? ethIn : 0n,
      approvals: native ? [] : [
        { kind: 'erc20', token: ADDR.WETH, spender: ADDR.PERMIT2, amount: ethIn },
        { kind: 'permit2', token: ADDR.WETH, spender: ADDR.UNIVERSAL_ROUTER, amount: ethIn },
      ],
      prep: native ? [] : [{ kind: 'wrap', amount: ethIn }],
    };
  },

  async buildSell(chain, route, tokensIn, minOut, _recipient, deadline): Promise<TxPlan> {
    const qc = quoteCurrency(route.poolKey!, route.token)!;
    const approvals: TxPlan['approvals'] = [
      { kind: 'erc20', token: route.token, spender: ADDR.PERMIT2, amount: tokensIn },
      { kind: 'permit2', token: route.token, spender: ADDR.UNIVERSAL_ROUTER, amount: tokensIn },
    ];
    if (qc.kind === 'token') {
      // 1) token -> karsi varlik (UniversalRouter v4) 2) karsi varlik -> ETH (Kyber, sonraki islem). minOut ETH cinsindendir; ara bacak icin %15 pay
      const sym = quoteSymbol(qc.quote);
      const qOut = await v4Quote(chain, route, !qc.quoteIs0, tokensIn, 'v4.quoteSell');
      const qMin = (qOut * 85n) / 100n;
      const leg = await buildKyberLeg(qc.quote, KYBER_NATIVE, (qOut * 90n) / 100n, minOut, chain.address, deadline, `${sym}->ETH (Kyber)`);
      const input = encodeV4SwapInput(route.poolKey!, !qc.quoteIs0, tokensIn, qMin, route.token, qc.quote);
      return { to: ADDR.UNIVERSAL_ROUTER, data: buildUrExecute(input, deadline), value: 0n, approvals, prep: [], post: [leg] };
    }
    const input = encodeV4SwapInput(route.poolKey!, !qc.quoteIs0, tokensIn, minOut, route.token, qc.quote);
    return { to: ADDR.UNIVERSAL_ROUTER, data: buildUrExecute(input, deadline), value: 0n, approvals, prep: [] };
  },
};
