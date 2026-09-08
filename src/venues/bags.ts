// hood.fun (Bags) bonding curve: mezuniyet oncesi alim/satim dogrudan egri sozlesmesi uzerinden yapilir.
import { ethers } from 'ethers';
import { ADDR } from '../constants.js';
import { BAGS_CURVE_ABI, BAGS_LENS_ABI } from '../abis/bags.js';
import { multicall, withRetry, type Chain } from '../rpc.js';
import type { Route } from '../types.js';
import type { Venue, TxPlan } from './types.js';

const lensIface = new ethers.Interface(BAGS_LENS_ABI as unknown as ethers.InterfaceAbi);
const curveIface = new ethers.Interface(BAGS_CURVE_ABI as unknown as ethers.InterfaceAbi);

export interface BagsState {
  exists: boolean; migrated: boolean; curve: string; feeShare: string; poolId: string;
  thresholdQuote: bigint; realQuoteReserves: bigint; realTokenReserves: bigint;
  virtualTokenReserves: bigint; virtualQuoteReserves: bigint; priceQuotePerToken: bigint; bondingProgressPct: bigint; totalRaised: bigint;
}

const stateCache = new Map<string, { at: number; st: BagsState }>();

export async function bagsState(chain: Chain, token: string, maxAgeMs = 1500): Promise<BagsState | null> {
  const k = token.toLowerCase();
  const c = stateCache.get(k);
  if (c && Date.now() - c.at < maxAgeMs) return c.st;
  const [r] = await multicall(chain, [{ target: ADDR.BAGS_LENS, iface: lensIface, fn: 'getTokenState', args: [token] }]);
  if (!r) return null;
  const s = r[0] as ethers.Result;
  const st: BagsState = {
    exists: Boolean(s.exists), migrated: Boolean(s.migrated), curve: String(s.curve), feeShare: String(s.feeShare), poolId: String(s.poolId),
    thresholdQuote: BigInt(s.thresholdQuote), realQuoteReserves: BigInt(s.realQuoteReserves), realTokenReserves: BigInt(s.realTokenReserves),
    virtualTokenReserves: BigInt(s.virtualTokenReserves), virtualQuoteReserves: BigInt(s.virtualQuoteReserves),
    priceQuotePerToken: BigInt(s.priceQuotePerToken), bondingProgressPct: BigInt(s.bondingProgressPct), totalRaised: BigInt(s.totalRaised),
  };
  if (!st.exists) return null;
  stateCache.set(k, { at: Date.now(), st });
  return st;
}

export const bagsCurve: Venue = {
  kind: 'bags',

  async findRoutes(chain, token) {
    const st = await bagsState(chain, token);
    if (!st || st.migrated) return [];
    return [{ kind: 'bags', token, label: 'hood.fun curve', curve: st.curve }];
  },

  async quoteBuy(chain, route, ethIn) {
    const c = new ethers.Contract(route.curve!, BAGS_CURVE_ABI as unknown as ethers.InterfaceAbi, chain.provider);
    const r = await withRetry(() => c.quoteBuy(ethIn), 'bags.quoteBuy');
    return BigInt(r[0]); // tokensOut
  },

  async quoteSell(chain, route, tokensIn) {
    const c = new ethers.Contract(route.curve!, BAGS_CURVE_ABI as unknown as ethers.InterfaceAbi, chain.provider);
    const r = await withRetry(() => c.quoteSell(tokensIn), 'bags.quoteSell');
    return BigInt(r[0]); // quoteToSeller
  },

  async liquidityEth(chain, route) {
    // Egri likiditesi sozlesmede kilitli, LP cekilemez. Sanal ETH rezervi fiyat derinligini temsil eder.
    const st = await bagsState(chain, route.token);
    return st ? st.virtualQuoteReserves : 0n;
  },

  poolFeePct: async () => 2,

  async buildBuy(_chain, route, ethIn, minOut): Promise<TxPlan> {
    return { to: route.curve!, data: curveIface.encodeFunctionData('buy', [minOut]), value: ethIn, approvals: [], prep: [] };
  },

  async buildSell(_chain, route, tokensIn, minOut): Promise<TxPlan> {
    return {
      to: route.curve!, data: curveIface.encodeFunctionData('sell', [tokensIn, minOut]), value: 0n,
      approvals: [{ kind: 'erc20', token: route.token, spender: route.curve!, amount: tokensIn }], prep: [],
    };
  },
};
