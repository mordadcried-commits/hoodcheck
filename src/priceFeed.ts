// ETH/USD fiyati ve piyasa degeri (MC) yardimcilari.
// ETH/USD: Kyber aggregator uzerinden 1 ETH -> USDG kotasi (zincir ici, API anahtari gerekmez); 60 sn onbellek, hata olursa son bilinen deger.
import { venueOf } from './venues/index.js';
import { ethUsdCached, ethUsdKnown as known } from './venues/kyber.js';
import { getTotalSupply } from './tokens.js';
import type { Chain } from './rpc.js';
import type { Route } from './types.js';

export const ethUsd = ethUsdCached;
export const ethUsdKnown = known;

const fmtMc = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${(v / 1000).toFixed(1)}k`);
export { fmtMc };

// Piyasa degeri ($): fiyat (ETH/token) * arz * ETH/USD. Fiyat bilinmiyorsa undefined.
export function marketCapUsd(priceEthPerToken1e18: bigint, supplyWei: bigint, decimals: number, usd: number): number | undefined {
  if (priceEthPerToken1e18 <= 0n || supplyWei <= 0n || !(usd > 0)) return undefined;
  const priceEth = Number(priceEthPerToken1e18) / 1e18;
  const supply = Number(supplyWei) / 10 ** decimals;
  return priceEth * supply * usd;
}

// Rotanin anlik fiyatindan MC; anlik fiyat yoksa verilen kota (ethOut / tokensIn) kullanilir
export async function routeMarketCapUsd(chain: Chain, route: Route, decimals: number, fallback?: { ethOut: bigint; tokensIn: bigint }): Promise<number | undefined> {
  const usd = await ethUsd();
  if (!(usd > 0)) return undefined;
  let supply: bigint;
  try { supply = await getTotalSupply(chain, route.token); } catch { return undefined; }
  let price = 0n;
  const v = venueOf(route);
  if (v.spotPriceEth) { try { price = await v.spotPriceEth(chain, route); } catch { /* kota ile tahmin */ } }
  if (price === 0n && fallback && fallback.tokensIn > 0n) price = (fallback.ethOut * 10n ** BigInt(decimals)) / fallback.tokensIn;
  return marketCapUsd(price, supply, decimals, usd);
}
