// Alim oncesi guvenlik kontrolleri: kara liste, havuz ucreti, likidite, kota bazli al-sat kaybi ve
// eth_simulateV1 ile GERCEK al -> onayla -> sat simulasyonu (honeypot / gizli satis vergisi / satis engeli).
import { ethers } from 'ethers';
import type { BotConfig } from './config.js';
import { ADDR } from './constants.js';
import { ERC20_ABI, MULTICALL3_ABI, PERMIT2_ABI, WETH_ABI } from './abis/uniswap.js';
import { fmtEth, simulate, simulateBlocks, type Chain, type SimCall } from './rpc.js';
import { venueOf } from './venues/index.js';
import { getUrVariant, setUrVariant } from './venues/uniswapV4.js';
import { ethUsdCached } from './venues/kyber.js';
import type { Route, TokenInfo } from './types.js';
import type { ApprovalNeed, PrepStep } from './venues/types.js';
import { log } from './logger.js';

const erc20 = new ethers.Interface(ERC20_ABI);
const weth = new ethers.Interface(WETH_ABI);
const permit2 = new ethers.Interface(PERMIT2_ABI);
const mc = new ethers.Interface(MULTICALL3_ABI);
const MAX160 = (1n << 160n) - 1n;
const MAX48 = (1n << 48n) - 1n;
// Simulasyonda satis, alimdan bu kadar saniye sonra: PONS v2 hook erken alicilara ~2-3 dk satis kilidi uyguluyor gibi (L+125 s revert, L+187 s OK)
const SIM_SELL_OFFSET_SEC = 240;

export interface SafetyReport {
  ok: boolean; reasons: string[]; tokensOut: bigint; liquidityEth: bigint; feePct: number; roundTripLossPct: number; simulatedLossPct?: number;
}

const approvalCalls = (a: ApprovalNeed[]): SimCall[] => a.map((x) => x.kind === 'erc20'
  ? { to: x.token, data: erc20.encodeFunctionData('approve', [x.spender, ethers.MaxUint256]) }
  : { to: ADDR.PERMIT2, data: permit2.encodeFunctionData('approve', [x.token, x.spender, MAX160, MAX48]) });

const asBig = (hex: string | undefined) => (hex && hex !== '0x' ? BigInt(hex) : 0n);
// On/son adimlar: WETH sarma veya ayri takas islemi (onaylariyla)
const stepCalls = (steps: PrepStep[] | undefined): SimCall[] => (steps ?? []).flatMap((p) => p.kind === 'wrap'
  ? [{ to: ADDR.WETH, data: weth.encodeFunctionData('deposit'), value: p.amount }]
  : [...approvalCalls(p.approvals ?? []), { to: p.to, data: p.data, value: p.value }]);

export async function preBuyChecks(chain: Chain, cfg: BotConfig['safety'], route: Route, token: TokenInfo, ethIn: bigint): Promise<SafetyReport> {
  const reasons: string[] = [];
  const venue = venueOf(route);
  if (cfg.tokenBlacklist.some((b) => b.toLowerCase() === token.address.toLowerCase())) reasons.push('token kara listede');

  const [feePct, liquidityEth] = await Promise.all([venue.poolFeePct(chain, route).catch(() => 0), venue.liquidityEth(chain, route).catch(() => -1n)]);
  if (feePct > cfg.maxPoolFeePct) reasons.push(`havuz ucreti %${feePct} > limit %${cfg.maxPoolFeePct}`);
  // -1n = likidite olculemiyor (Kyber cok atlamali rota vb.): al-sat kaybi kontrolu bu durumu yakalar
  if (liquidityEth >= 0n && liquidityEth < ethers.parseEther(String(cfg.minLiquidityEth))) reasons.push(`likidite ${fmtEth(liquidityEth, 4)} ETH < minimum ${cfg.minLiquidityEth} ETH`);

  let tokensOut = 0n, roundTripLossPct = 100;
  try {
    tokensOut = await venue.quoteBuy(chain, route, ethIn);
    const back = await venue.quoteSell(chain, route, tokensOut);
    roundTripLossPct = Number(((ethIn - back) * 10_000n) / ethIn) / 100;
    if (roundTripLossPct > cfg.maxRoundTripLossPct) reasons.push(`al-sat kaybi %${roundTripLossPct.toFixed(1)} > limit %${cfg.maxRoundTripLossPct} (dusuk likidite / yuksek ucret)`);
  } catch (e) { reasons.push(`kota alinamadi: ${(e as Error).message.slice(0, 100)}`); }

  let simulatedLossPct: number | undefined;
  if (reasons.length === 0 && cfg.simulateRoundTrip && tokensOut > 0n) {
    if (!chain.supportsSimulate) log.debug('RPC eth_simulateV1 desteklemiyor, gercek simulasyon atlandi');
    else {
      const sim = await simulateRoundTrip(chain, route, token, ethIn).catch((e) => ({ ok: true, lossPct: -1, reason: `simulasyon calistirilamadi: ${(e as Error).message.slice(0, 80)}`, buyFailed: false }));
      simulatedLossPct = sim.lossPct;
      if (!sim.ok) reasons.push(sim.reason!);
      else if (sim.reason) log.debug(sim.reason);
      else if (sim.lossPct > cfg.maxRoundTripLossPct + 5) reasons.push(`simulasyon: gercek al-sat kaybi %${sim.lossPct.toFixed(1)} (gizli vergi?)`);
    }
  }
  return { ok: reasons.length === 0, reasons, tokensOut, liquidityEth, feePct, roundTripLossPct, simulatedLossPct };
}

interface SimOutcome { ok: boolean; lossPct: number; reason?: string; buyFailed: boolean; }

export async function simulateRoundTrip(chain: Chain, route: Route, token: TokenInfo, ethIn: bigint): Promise<SimOutcome> {
  const me = chain.address; const venue = venueOf(route);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const balance = ethIn * 3n + ethers.parseEther('0.05');

  const run = async (): Promise<SimOutcome> => {
    const buy = await venue.buildBuy(chain, route, ethIn, 0n, me, deadline);
    const preSteps = stepCalls(buy.prep);
    const pre: SimCall[] = [
      { to: ADDR.MULTICALL3, data: mc.encodeFunctionData('getEthBalance', [me]) },
      { to: ADDR.WETH, data: erc20.encodeFunctionData('balanceOf', [me]) },
      { to: token.address, data: erc20.encodeFunctionData('balanceOf', [me]) },
      ...preSteps,
      ...approvalCalls(buy.approvals),
      { to: buy.to, data: buy.data, value: buy.value },
      { to: token.address, data: erc20.encodeFunctionData('balanceOf', [me]) },
      { to: ADDR.USDG, data: erc20.encodeFunctionData('balanceOf', [me]) }, // USDG bacakli rotalarda ara varlik bakiyesi
    ];
    const r1 = await simulate(chain, me, pre, balance);
    for (let i = 0; i < preSteps.length; i++) { const st = r1[3 + i]; if (st?.status !== 1) return { ok: false, lossPct: 100, reason: `simulasyon: alim on adimi revert (${st?.error ?? 'bilinmiyor'})`, buyFailed: false }; }
    const buyRes = r1[pre.length - 3];
    if (buyRes?.status !== 1) return { ok: false, lossPct: 100, reason: `simulasyon: ALIM revert (${buyRes?.error ?? 'bilinmiyor'})`, buyFailed: true };
    const got = asBig(r1[pre.length - 2]?.returnData) - asBig(r1[2]?.returnData); // alimdan gelen token = bakiye farki
    if (got === 0n) return { ok: false, lossPct: 100, reason: 'simulasyon: alimdan sonra token bakiyesi 0', buyFailed: false };
    const usdgBefore = asBig(r1[pre.length - 1]?.returnData);

    const sell = await venue.buildSell(chain, route, got, 0n, me, deadline);
    // Satis ayri bir sanal blokta ve 90 sn sonra: "ayni blokta al-sat yasak" / bekleme suresi gibi anti-bot kurallari sahte alarm vermesin
    const sellApprovals = approvalCalls(sell.approvals);
    const postSteps = stepCalls(sell.post);
    const sellCalls: SimCall[] = [
      ...sellApprovals, { to: sell.to, data: sell.data, value: sell.value },
      ...postSteps,
      { to: token.address, data: erc20.encodeFunctionData('balanceOf', [me]) },
      { to: ADDR.MULTICALL3, data: mc.encodeFunctionData('getEthBalance', [me]) },
      { to: ADDR.WETH, data: erc20.encodeFunctionData('balanceOf', [me]) },
      { to: ADDR.USDG, data: erc20.encodeFunctionData('balanceOf', [me]) },
    ];
    const [rA, rB] = await simulateBlocks(chain, me, [{ calls: pre }, { calls: sellCalls, timeOffsetSec: SIM_SELL_OFFSET_SEC }], balance);
    const n = sellCalls.length;
    const sellRes = rB?.[sellApprovals.length];
    if (sellRes?.status !== 1) return { ok: false, lossPct: 100, reason: `HONEYPOT SUPHESI: simulasyonda SATIS revert (${sellRes?.error ?? 'bilinmiyor'})`, buyFailed: false };
    // Satis sonrasi adim (USDG -> ETH) basarisizsa: tokenler satilmis, gelir USDG olarak elde -> USDG farkini ETH'ye cevirip say (yumusak hata)
    let postNote = '';
    for (let i = 0; i < postSteps.length; i++) { const st = rB?.[sellApprovals.length + 1 + i]; if (st?.status !== 1) { postNote = `USDG->ETH bacagi simulasyonda revert (${(st?.error ?? 'bilinmiyor').slice(0, 60)}); gelir USDG olarak sayildi`; break; } }
    const left = asBig(rB[n - 4]?.returnData);
    const before = asBig(rA?.[0]?.returnData) + asBig(rA?.[1]?.returnData);
    let after = asBig(rB[n - 3]?.returnData) + asBig(rB[n - 2]?.returnData);
    const usdgDelta = asBig(rB[n - 1]?.returnData) - usdgBefore;
    if (usdgDelta > 0n) {
      const usd = await ethUsdCached().catch(() => 0);
      if (usd > 0) after += (usdgDelta * 10n ** 12n * 1_000_000n) / BigInt(Math.round(usd * 1_000_000));
      else if (postNote) return { ok: false, lossPct: 100, reason: 'simulasyon: USDG->ETH bacagi revert ve ETH/USD bilinmiyor', buyFailed: false };
    }
    const lossPct = Number(((before - after) * 10_000n) / ethIn) / 100;
    if (left * 10n > got) return { ok: false, lossPct, reason: `simulasyon: satistan sonra tokenlerin %${Number((left * 100n) / got)}'i cuzdanda kaldi (kismi satis engeli)`, buyFailed: false };
    if (left * 100n > got) log.debug(`simulasyon: satis sonrasi %${Number((left * 100n) / got)} token kaldi (refleksiyon/vergi olabilir), kabul edildi`);
    return { ok: true, lossPct, buyFailed: false, reason: postNote || undefined };
  };

  let res = await run();
  if (res.buyFailed && route.kind === 'v4') {
    // UniversalRouter kodlama varyanti yanlis olabilir; digerini dene
    const prev = getUrVariant(); const other = prev === 'robinhood' ? 'standard' : 'robinhood';
    setUrVariant(other);
    const res2 = await run();
    if (!res2.buyFailed) { log.warn(`UniversalRouter v4 kodlamasi "${other}" olarak degistirildi (oncekiyle alim revert etti)`); return res2; }
    setUrVariant(prev);
  }
  return res;
}
