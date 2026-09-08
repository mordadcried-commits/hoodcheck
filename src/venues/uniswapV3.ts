import { ethers } from 'ethers';
import { ADDR, V3_FEE_TIERS } from '../constants.js';
import { ERC20_ABI, V3_FACTORY_ABI, V3_POOL_ABI, V3_QUOTER_V2_ABI, V3_SWAP_ROUTER_02_ABI } from '../abis/uniswap.js';
import { multicall, withRetry, type Chain } from '../rpc.js';
import type { Route, SignalHints } from '../types.js';
import type { Venue, TxPlan } from './types.js';

const factoryIface = new ethers.Interface(V3_FACTORY_ABI);
const poolIface = new ethers.Interface(V3_POOL_ABI);
const routerIface = new ethers.Interface(V3_SWAP_ROUTER_02_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'; // SwapRouter02: cikti router'da kalsin (unwrap icin)

export const uniswapV3: Venue = {
  kind: 'v3',

  async findRoutes(chain, token, hints?: SignalHints) {
    const res = await multicall(chain, V3_FEE_TIERS.map((fee) => ({ target: ADDR.UNI_V3_FACTORY, iface: factoryIface, fn: 'getPool', args: [token, ADDR.WETH, fee] })));
    const candidates = new Map<string, number | undefined>();
    res.forEach((r, i) => { const p = r ? String(r[0]) : ADDR.ZERO; if (p !== ADDR.ZERO) candidates.set(p.toLowerCase(), V3_FEE_TIERS[i]); });
    for (const p of hints?.v3Pools ?? []) if (!candidates.has(p.toLowerCase())) candidates.set(p.toLowerCase(), undefined);
    if (candidates.size === 0) return [];
    const pools = [...candidates.keys()];
    const info = await multicall(chain, pools.flatMap((p) => [
      { target: p, iface: poolIface, fn: 'token0' }, { target: p, iface: poolIface, fn: 'token1' },
      { target: p, iface: poolIface, fn: 'fee' }, { target: p, iface: poolIface, fn: 'liquidity' },
    ]));
    const routes: Route[] = [];
    pools.forEach((p, i) => {
      const [t0, t1, fee, liq] = [info[i * 4], info[i * 4 + 1], info[i * 4 + 2], info[i * 4 + 3]];
      if (!t0 || !t1 || !fee || !liq) return;
      const toks = [String(t0[0]).toLowerCase(), String(t1[0]).toLowerCase()];
      if (!toks.includes(token.toLowerCase()) || !toks.includes(ADDR.WETH.toLowerCase())) return;
      if (BigInt(liq[0]) === 0n) return;
      const f = Number(fee[0]);
      routes.push({ kind: 'v3', token, label: `Uniswap v3 ${(f / 10_000).toString()}%`, pool: ethers.getAddress(p), fee: f });
    });
    return routes;
  },

  async quoteBuy(chain, route, ethIn) {
    const q = new ethers.Contract(ADDR.UNI_V3_QUOTER_V2, V3_QUOTER_V2_ABI, chain.provider);
    const r = await withRetry(() => q.quoteExactInputSingle.staticCall({ tokenIn: ADDR.WETH, tokenOut: route.token, amountIn: ethIn, fee: route.fee!, sqrtPriceLimitX96: 0n }), 'v3.quoteBuy');
    return BigInt(r[0]);
  },

  async quoteSell(chain, route, tokensIn) {
    const q = new ethers.Contract(ADDR.UNI_V3_QUOTER_V2, V3_QUOTER_V2_ABI, chain.provider);
    const r = await withRetry(() => q.quoteExactInputSingle.staticCall({ tokenIn: route.token, tokenOut: ADDR.WETH, amountIn: tokensIn, fee: route.fee!, sqrtPriceLimitX96: 0n }), 'v3.quoteSell');
    return BigInt(r[0]);
  },

  async liquidityEth(chain, route) {
    const [r] = await multicall(chain, [{ target: ADDR.WETH, iface: erc20Iface, fn: 'balanceOf', args: [route.pool!] }]);
    return r ? BigInt(r[0]) : 0n;
  },

  poolFeePct: async (_c, route) => (route.fee ?? 3000) / 10_000,

  async buildBuy(_chain, route, ethIn, minOut, recipient): Promise<TxPlan> {
    return {
      to: ADDR.UNI_V3_SWAP_ROUTER_02,
      data: routerIface.encodeFunctionData('exactInputSingle', [{ tokenIn: ADDR.WETH, tokenOut: route.token, fee: route.fee!, recipient, amountIn: ethIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }]),
      value: ethIn, approvals: [], prep: [],
    };
  },

  async buildSell(_chain, route, tokensIn, minOut, recipient, deadline): Promise<TxPlan> {
    const swap = routerIface.encodeFunctionData('exactInputSingle', [{ tokenIn: route.token, tokenOut: ADDR.WETH, fee: route.fee!, recipient: ADDRESS_THIS, amountIn: tokensIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }]);
    const unwrap = routerIface.encodeFunctionData('unwrapWETH9', [minOut, recipient]);
    return {
      to: ADDR.UNI_V3_SWAP_ROUTER_02,
      data: routerIface.encodeFunctionData('multicall', [deadline, [swap, unwrap]]),
      value: 0n,
      approvals: [{ kind: 'erc20', token: route.token, spender: ADDR.UNI_V3_SWAP_ROUTER_02, amount: tokensIn }],
      prep: [],
    };
  },
};
