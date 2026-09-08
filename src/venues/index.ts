import type { Chain } from '../rpc.js';
import type { Route, SignalHints, VenueKind } from '../types.js';
import { bagsCurve } from './bags.js';
import { uniswapV2 } from './uniswapV2.js';
import { uniswapV3 } from './uniswapV3.js';
import { uniswapV4 } from './uniswapV4.js';
import { kyber } from './kyber.js';
import { pons } from './pons.js';
import type { Venue } from './types.js';
import { log } from '../logger.js';

export const VENUES: Record<VenueKind, Venue> = { bags: bagsCurve, pons, v2: uniswapV2, v3: uniswapV3, v4: uniswapV4, kyber };
export const venueOf = (route: Route): Venue => VENUES[route.kind];

export async function discoverRoutes(chain: Chain, token: string, enabled: VenueKind[], hints?: SignalHints): Promise<Route[]> {
  const results = await Promise.allSettled(enabled.map((k) => VENUES[k].findRoutes(chain, token, hints)));
  const routes: Route[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') routes.push(...r.value);
    else log.debug(`${enabled[i]} havuz kesfi hatasi`, (r.reason as Error)?.message);
  });
  return routes;
}

export async function bestBuyRoute(chain: Chain, routes: Route[], ethIn: bigint): Promise<{ route: Route; tokensOut: bigint } | null> {
  const quotes = await Promise.allSettled(routes.map((r) => venueOf(r).quoteBuy(chain, r, ethIn)));
  let best: { route: Route; tokensOut: bigint } | null = null;
  quotes.forEach((q, i) => {
    if (q.status !== 'fulfilled') { log.debug(`${routes[i].label} alim kotasi alinamadi`, (q.reason as Error)?.message); return; }
    // Dogrudan havuz rotalari daha hizli; Kyber ancak belirgin daha iyi kota verirse secilir
    const adj = routes[i].kind === 'kyber' ? (q.value * 990n) / 1000n : q.value;
    if (q.value > 0n && (!best || adj > (best.route.kind === 'kyber' ? (best.tokensOut * 990n) / 1000n : best.tokensOut))) best = { route: routes[i], tokensOut: q.value };
  });
  return best;
}

export async function bestSellRoute(chain: Chain, routes: Route[], tokensIn: bigint): Promise<{ route: Route; ethOut: bigint } | null> {
  const quotes = await Promise.allSettled(routes.map((r) => venueOf(r).quoteSell(chain, r, tokensIn)));
  let best: { route: Route; ethOut: bigint } | null = null;
  quotes.forEach((q, i) => {
    if (q.status !== 'fulfilled') return;
    if (q.value > 0n && (!best || q.value > best.ethOut)) best = { route: routes[i], ethOut: q.value };
  });
  return best;
}
