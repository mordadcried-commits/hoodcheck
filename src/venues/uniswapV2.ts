import { ethers } from 'ethers';
import { ADDR } from '../constants.js';
import { V2_FACTORY_ABI, V2_PAIR_ABI, V2_ROUTER_ABI } from '../abis/uniswap.js';
import { multicall, withRetry, type Chain } from '../rpc.js';
import type { Route, SignalHints } from '../types.js';
import type { Venue, TxPlan } from './types.js';

const pairIface = new ethers.Interface(V2_PAIR_ABI);
const routerIface = new ethers.Interface(V2_ROUTER_ABI);
const factoryIface = new ethers.Interface(V2_FACTORY_ABI);

async function pairInfo(chain: Chain, pair: string): Promise<{ token0: string; token1: string; r0: bigint; r1: bigint } | null> {
  const [t0, t1, res] = await multicall(chain, [
    { target: pair, iface: pairIface, fn: 'token0' },
    { target: pair, iface: pairIface, fn: 'token1' },
    { target: pair, iface: pairIface, fn: 'getReserves' },
  ]);
  if (!t0 || !t1 || !res) return null;
  return { token0: String(t0[0]), token1: String(t1[0]), r0: BigInt(res[0]), r1: BigInt(res[1]) };
}

async function wethReserve(chain: Chain, route: Route): Promise<bigint> {
  const info = await pairInfo(chain, route.pool!);
  if (!info) return 0n;
  return info.token0.toLowerCase() === ADDR.WETH.toLowerCase() ? info.r0 : info.r1;
}

export const uniswapV2: Venue = {
  kind: 'v2',

  async findRoutes(chain, token, hints?: SignalHints) {
    const candidates = new Set<string>();
    const [pairRes] = await multicall(chain, [{ target: ADDR.UNI_V2_FACTORY, iface: factoryIface, fn: 'getPair', args: [token, ADDR.WETH] }]);
    const pair = pairRes ? String(pairRes[0]) : ADDR.ZERO;
    if (pair !== ADDR.ZERO) candidates.add(pair);
    for (const p of hints?.v2Pairs ?? []) candidates.add(p);
    const routes: Route[] = [];
    for (const p of candidates) {
      const info = await pairInfo(chain, p);
      if (!info) continue;
      const toks = [info.token0.toLowerCase(), info.token1.toLowerCase()];
      if (!toks.includes(token.toLowerCase()) || !toks.includes(ADDR.WETH.toLowerCase())) continue;
      const rW = info.token0.toLowerCase() === ADDR.WETH.toLowerCase() ? info.r0 : info.r1;
      if (rW === 0n) continue;
      routes.push({ kind: 'v2', token, label: 'Uniswap v2', pool: ethers.getAddress(p) });
    }
    return routes;
  },

  async quoteBuy(chain, route, ethIn) {
    const router = new ethers.Contract(ADDR.UNI_V2_ROUTER, V2_ROUTER_ABI, chain.provider);
    const amounts: bigint[] = await withRetry(() => router.getAmountsOut(ethIn, [ADDR.WETH, route.token]), 'v2.getAmountsOut');
    return BigInt(amounts[1]);
  },

  async quoteSell(chain, route, tokensIn) {
    const router = new ethers.Contract(ADDR.UNI_V2_ROUTER, V2_ROUTER_ABI, chain.provider);
    const amounts: bigint[] = await withRetry(() => router.getAmountsOut(tokensIn, [route.token, ADDR.WETH]), 'v2.getAmountsOut');
    return BigInt(amounts[1]);
  },

  liquidityEth: (chain, route) => wethReserve(chain, route),
  poolFeePct: async () => 0.3,

  async buildBuy(_chain, route, ethIn, minOut, recipient, deadline): Promise<TxPlan> {
    return {
      to: ADDR.UNI_V2_ROUTER,
      data: routerIface.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [minOut, [ADDR.WETH, route.token], recipient, deadline]),
      value: ethIn, approvals: [], prep: [],
    };
  },

  async buildSell(_chain, route, tokensIn, minOut, recipient, deadline): Promise<TxPlan> {
    return {
      to: ADDR.UNI_V2_ROUTER,
      data: routerIface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [tokensIn, minOut, [route.token, ADDR.WETH], recipient, deadline]),
      value: 0n,
      approvals: [{ kind: 'erc20', token: route.token, spender: ADDR.UNI_V2_ROUTER, amount: tokensIn }],
      prep: [],
    };
  },
};
