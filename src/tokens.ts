import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import type { Chain } from './rpc.js';
import { multicall } from './rpc.js';
import { ERC20_ABI } from './abis/uniswap.js';
import type { TokenInfo } from './types.js';
import { ADDR } from './constants.js';

const FILE = path.resolve('data', 'tokens.json');
const iface = new ethers.Interface(ERC20_ABI);
const cache = new Map<string, TokenInfo>();

(function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as TokenInfo[];
    for (const t of raw) cache.set(t.address.toLowerCase(), t);
  } catch { /* ilk calistirma */ }
  cache.set(ADDR.WETH.toLowerCase(), { address: ADDR.WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 });
})();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...cache.values()], null, 1));
  } catch { /* onbellek yazilamazsa sorun degil */ }
}

function decodeString(r: ethers.Result | null): string | null {
  if (!r) return null;
  const v = r[0];
  if (typeof v === 'string') return v.replace(/\0+$/g, '').trim();
  return null;
}

export async function getTokenInfos(chain: Chain, addresses: string[]): Promise<Map<string, TokenInfo>> {
  const out = new Map<string, TokenInfo>();
  const missing: string[] = [];
  for (const a of addresses) {
    const k = a.toLowerCase();
    const c = cache.get(k);
    if (c) out.set(k, c); else missing.push(ethers.getAddress(a));
  }
  if (missing.length) {
    const items = missing.flatMap((t) => [
      { target: t, iface, fn: 'symbol' },
      { target: t, iface, fn: 'name' },
      { target: t, iface, fn: 'decimals' },
    ]);
    const res = await multicall(chain, items);
    missing.forEach((t, i) => {
      const symbol = decodeString(res[i * 3]) || t.slice(2, 8).toUpperCase();
      const name = decodeString(res[i * 3 + 1]) || symbol;
      const dec = res[i * 3 + 2] ? Number(res[i * 3 + 2]![0]) : 18;
      const info: TokenInfo = { address: t, symbol: symbol.slice(0, 24), name: name.slice(0, 48), decimals: Number.isFinite(dec) ? dec : 18 };
      cache.set(t.toLowerCase(), info);
      out.set(t.toLowerCase(), info);
    });
    persist();
  }
  return out;
}

export async function getTokenInfo(chain: Chain, address: string): Promise<TokenInfo> {
  const m = await getTokenInfos(chain, [address]);
  return m.get(address.toLowerCase())!;
}

// Toplam arz (MC hesabi icin); bir kez okunur, onbellege yazilir
export async function getTotalSupply(chain: Chain, address: string): Promise<bigint> {
  const info = await getTokenInfo(chain, address);
  if (info.totalSupply) return BigInt(info.totalSupply);
  const [r] = await multicall(chain, [{ target: info.address, iface, fn: 'totalSupply' }]);
  if (!r) throw new Error('totalSupply okunamadi');
  info.totalSupply = BigInt(r[0]).toString();
  persist();
  return BigInt(info.totalSupply);
}

// Ayni sembolu tasiyan kac AYRI token gormusuz? (taklit isim riski icin)
// Onbellek bot acildigindan beri gordugu her tokeni tutar; sayim oradan gelir.
export function symbolCount(symbol: string): number {
  const s = symbol.trim().toUpperCase();
  if (!s) return 0;
  let n = 0;
  for (const t of cache.values()) if (t.symbol.trim().toUpperCase() === s) n++;
  return n;
}
