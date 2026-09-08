// PONS launchpad bonding curve (lansman asamasi). Sozlesme dogrulanmamis; arayuz zincirden cikarildi:
//   buy(uint256 amountIn, uint256 minOut, address recipient) payable returns (uint256 tokensOut)   [ETH karsiligi egrilerde amountIn = msg.value; token karsiligi egrilerde once approve]
//   sell(uint256 amountIn, uint256 minOut, address recipient) returns (uint256 quoteOut)          [once egriye approve gerekir]
// Ozellikler: feeBps (%1) + creatorTaxBps, ilk 3 sn'de %99'a varan "snipe tax", islem basina max fiyat etkisi (%3),
// mezuniyet esigine ulasinca Uniswap v4 havuzuna gecer (graduated=true) -> o andan sonra v4/Kyber venue kullanilir.
// Karsi varlik: native ETH veya USDG (pairToken). USDG egrilerinde ETH bacagi Kyber ile ayri islem olarak eklenir.
import { ethers } from 'ethers';
import { ADDR, PONS, PONS_TOPICS } from '../constants.js';
import { multicall, publicScan, withRetry, type Chain } from '../rpc.js';
import type { Route, SignalHints } from '../types.js';
import type { Venue, TxPlan } from './types.js';
import { buildKyberLeg, ethUsdCached, KYBER_NATIVE, quoteEthToUsdg, quoteUsdgToEth } from './kyber.js';
import { log } from '../logger.js';

const iface = new ethers.Interface([
  'function buy(uint256 amountIn, uint256 minOut, address recipient) payable returns (uint256)',
  'function sell(uint256 amountIn, uint256 minOut, address recipient) returns (uint256)',
  'function token() view returns (address)',
  'function graduated() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address) view returns (uint256)',
  'function launchedAt() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
]);
const USDG = ADDR.USDG.toLowerCase();

export interface PonsState { curve: string; graduated: boolean; native: boolean; pairToken: string; quoteReserve: bigint; tokenReserve: bigint; realQuote: bigint; feeBps: number; creatorTaxBps: number; threshold: bigint; }
const curveCache = new Map<string, string>(); // token -> curve
// Egrisi olmadigi anlasilan tokenler (tekrar taranmaz)
const noCurveCache = new Set<string>();
const isUsdgRoute = (route: Route) => !!route.quoteToken && route.quoteToken.toLowerCase() === USDG;

// Tokenin egrisi: sinyal ipucu varsa onu kullan, yoksa fabrika olaylarini geriye dogru tara (public RPC)
export async function ponsCurveOf(chain: Chain, token: string, hint?: string): Promise<string | null> {
  const t = token.toLowerCase();
  if (hint) curveCache.set(t, hint.toLowerCase());
  const c = curveCache.get(t);
  if (c) return c;
  // Negatif onbellek: egrisi olmayan tokenler icin ayni 2 milyon bloklu taramayi tekrar tekrar yapmak
  // RPC hiz limitinin tek basina en buyuk tuketicisiydi (72 limitin 71'i 'pons.create'). Bir kez bakilir.
  if (noCurveCache.has(t)) return null;
  const head = await chain.publicProvider.getBlockNumber();
  for (let i = 0; i < 4; i++) {
    const to = head - 500_000 * i, from = Math.max(0, to - 500_000);
    const logs = await publicScan(() => withRetry(() => chain.publicProvider.getLogs({ address: PONS.FACTORY, topics: [PONS_TOPICS.CREATE, ethers.zeroPadValue(token, 32)], fromBlock: from, toBlock: to }), 'pons.create', 3)).catch(() => [] as ethers.Log[]);
    if (logs.length) { const curve = ('0x' + logs[0].topics[2].slice(26)).toLowerCase(); curveCache.set(t, curve); return curve; }
  }
  noCurveCache.add(t);
  if (noCurveCache.size > 20_000) noCurveCache.clear();
  return null;
}

export async function ponsState(chain: Chain, curve: string): Promise<PonsState | null> {
  const fns = ['graduated', 'isNativeQuote', 'getReserves', 'realQuoteReserve', 'feeBps', 'creatorTaxBps', 'graduationThreshold', 'pairToken'];
  const r = await multicall(chain, fns.map((fn) => ({ target: curve, iface, fn })));
  if (!r[0] || !r[2]) return null;
  return {
    curve, graduated: Boolean(r[0][0]), native: r[1] ? Boolean(r[1][0]) : false, pairToken: r[7] ? String(r[7][0]) : ADDR.ZERO,
    quoteReserve: BigInt(r[2][0]), tokenReserve: BigInt(r[2][1]), realQuote: r[3] ? BigInt(r[3][0]) : 0n,
    feeBps: r[4] ? Number(r[4][0]) : 100, creatorTaxBps: r[5] ? Number(r[5][0]) : 0, threshold: r[6] ? BigInt(r[6][0]) : 0n,
  };
}

async function snipeTaxBps(chain: Chain, curve: string): Promise<number> {
  const [s] = await multicall(chain, [{ target: curve, iface, fn: 'currentSnipeTaxBps', args: [chain.address] }]);
  return s ? Number(s[0]) : 0;
}

// USDG (6 ondalik) -> wei
async function usdgToWei(usdg: bigint): Promise<bigint> {
  const usd = await ethUsdCached();
  if (!(usd > 0)) throw new Error('ETH/USD bilinmiyor (Kyber)');
  return (usdg * 10n ** 12n * 1_000_000n) / BigInt(Math.round(usd * 1_000_000));
}

// x*y=k alim matematigi: ucretler girdiden dusulur (BUY olayi: quoteIn, tokensOut, fee, creatorFee)
function curveBuyMath(st: PonsState, quoteIn: bigint, snipeBps: number): bigint {
  const net = (quoteIn * BigInt(Math.max(0, 10_000 - st.feeBps - st.creatorTaxBps - snipeBps))) / 10_000n;
  if (net <= 0n) return 0n;
  return (st.tokenReserve * net) / (st.quoteReserve + net);
}
function curveSellMath(st: PonsState, tokensIn: bigint): bigint {
  const gross = (st.quoteReserve * tokensIn) / (st.tokenReserve + tokensIn);
  return (gross * BigInt(Math.max(0, 10_000 - st.feeBps - st.creatorTaxBps))) / 10_000n;
}

export const pons: Venue = {
  kind: 'pons',

  async findRoutes(chain, token, hints?: SignalHints) {
    const curve = await ponsCurveOf(chain, token, hints?.ponsCurve);
    if (!curve) return [];
    const st = await ponsState(chain, curve);
    if (!st || st.graduated) return [];
    const pct = st.threshold > 0n ? Number((st.realQuote * 100n) / st.threshold) : 0;
    if (st.native) return [{ kind: 'pons', token, label: `PONS curve (%${pct} dolu)`, curve: ethers.getAddress(curve), lpLocked: true, curveFillPct: pct }];
    if (st.pairToken.toLowerCase() === USDG) return [{ kind: 'pons', token, label: `PONS curve USDG (%${pct} dolu)`, curve: ethers.getAddress(curve), quoteToken: ADDR.USDG, lpLocked: true, curveFillPct: pct }];
    log.debug(`PONS egrisi ETH/USDG degil (${st.pairToken.slice(0, 10)} karsiligi, ${token.slice(0, 10)}); atlandi`);
    return [];
  },

  // ETH egrisi: buy() tokensOut dondurur, bakiye override ile eth_call yeterli. USDG egrisi: Kyber ETH->USDG kotasi + rezerv matematigi
  async quoteBuy(chain, route, ethIn) {
    const me = chain.address;
    if (isUsdgRoute(route)) {
      const [usdgIn, st, snipe] = await Promise.all([quoteEthToUsdg(ethIn), ponsState(chain, route.curve!), snipeTaxBps(chain, route.curve!)]);
      if (!st) throw new Error('PONS egri durumu okunamadi');
      if (st.graduated) throw new Error('PONS egrisi mezun oldu; havuz rotasi gerekli');
      const out = curveBuyMath(st, usdgIn, snipe);
      if (out === 0n) throw new Error('PONS: alim kotasi 0');
      return out;
    }
    const data = iface.encodeFunctionData('buy', [ethIn, 0n, me]);
    const r = (await withRetry(() => chain.provider.send('eth_call', [{ from: me, to: route.curve, data, value: ethers.toQuantity(ethIn) }, 'latest', { [me]: { balance: ethers.toQuantity(ethIn * 2n + ethers.parseEther('0.01')) } }]), 'pons.quoteBuy')) as string;
    const out = BigInt(r);
    if (out === 0n) throw new Error('PONS: alim kotasi 0 (egri mezun olmus veya fiyat etkisi siniri)');
    return out;
  },

  // Elimizde token + onay varsa gercek sell() cagrisi; yoksa rezerv matematigi (x*y=k, ucretler dusulmus). USDG egrisinde sonuc Kyber ile ETH'ye cevrilir
  async quoteSell(chain, route, tokensIn) {
    const me = chain.address;
    let quoteOut = 0n;
    try {
      const r = (await chain.provider.send('eth_call', [{ from: me, to: route.curve, data: iface.encodeFunctionData('sell', [tokensIn, 0n, me]) }, 'latest'])) as string;
      if (BigInt(r) > 0n) quoteOut = BigInt(r);
    } catch { /* elimizde token yok veya onay yok */ }
    if (quoteOut === 0n) {
      const st = await ponsState(chain, route.curve!);
      if (!st) throw new Error('PONS egri durumu okunamadi');
      if (st.graduated) throw new Error('PONS egrisi mezun oldu; havuz rotasi gerekli');
      quoteOut = curveSellMath(st, tokensIn);
    }
    return isUsdgRoute(route) ? quoteUsdgToEth(quoteOut) : quoteOut;
  },

  // Sanal rezerv (Bags gibi): LP cekilemez, dusus = toplu satis. Mezun olduysa rota gecersiz -> hata (trader rotayi yeniler)
  async liquidityEth(chain, route) {
    const st = await ponsState(chain, route.curve!);
    if (!st) throw new Error('PONS egri durumu okunamadi');
    if (st.graduated) throw new Error('PONS egrisi mezun oldu; havuz rotasi gerekli');
    return isUsdgRoute(route) ? usdgToWei(st.quoteReserve) : st.quoteReserve;
  },

  async spotPriceEth(chain, route) {
    const st = await ponsState(chain, route.curve!);
    if (!st || st.tokenReserve === 0n) throw new Error('PONS egri durumu okunamadi');
    const pq = (st.quoteReserve * 10n ** 18n) / st.tokenReserve; // karsi varlik birimi / 1e18 token
    return isUsdgRoute(route) ? usdgToWei(pq) : pq;
  },

  // ucret + yaratici vergisi + (ilk saniyelerde) snipe vergisi
  async poolFeePct(chain, route) {
    const [st, tax] = await Promise.all([ponsState(chain, route.curve!), snipeTaxBps(chain, route.curve!)]);
    return ((st?.feeBps ?? 100) + (st?.creatorTaxBps ?? 0) + tax) / 100;
  },

  async buildBuy(chain, route, ethIn, minOut, _recipient, deadline): Promise<TxPlan> {
    if (isUsdgRoute(route)) {
      const usdgQuote = await quoteEthToUsdg(ethIn);
      const usdgIn = (usdgQuote * 990n) / 1000n;
      const leg = await buildKyberLeg(KYBER_NATIVE, ADDR.USDG, ethIn, usdgIn, chain.address, deadline, 'ETH->USDG (Kyber)');
      return { to: route.curve!, data: iface.encodeFunctionData('buy', [usdgIn, minOut, chain.address]), value: 0n, approvals: [{ kind: 'erc20', token: ADDR.USDG, spender: route.curve!, amount: usdgIn }], prep: [leg] };
    }
    return { to: route.curve!, data: iface.encodeFunctionData('buy', [ethIn, minOut, chain.address]), value: ethIn, approvals: [], prep: [] };
  },

  async buildSell(chain, route, tokensIn, minOut, _recipient, deadline): Promise<TxPlan> {
    const approvals: TxPlan['approvals'] = [{ kind: 'erc20', token: route.token, spender: route.curve!, amount: tokensIn }];
    if (isUsdgRoute(route)) {
      const st = await ponsState(chain, route.curve!);
      if (!st) throw new Error('PONS egri durumu okunamadi');
      const usdgOut = curveSellMath(st, tokensIn);
      const leg = await buildKyberLeg(ADDR.USDG, KYBER_NATIVE, (usdgOut * 90n) / 100n, minOut, chain.address, deadline, 'USDG->ETH (Kyber)');
      return { to: route.curve!, data: iface.encodeFunctionData('sell', [tokensIn, (usdgOut * 85n) / 100n, chain.address]), value: 0n, approvals, prep: [], post: [leg] };
    }
    return { to: route.curve!, data: iface.encodeFunctionData('sell', [tokensIn, minOut, chain.address]), value: 0n, approvals, prep: [] };
  },
};
