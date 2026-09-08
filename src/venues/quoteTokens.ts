// Karsi varlik olarak kabul edilen tokenler: ETH/WETH disinda bir tokenle fiyatlanan havuzlar
// (USDG, pair.fund hisse tokenleri: SPY, AMC, GLD, NVDA...) ancak bu listede olursa islem gorur.
// ETH bacagi Kyber ile eklenir; liste disi token/token havuzlari rota olarak uretilmez.
import { ADDR } from '../constants.js';

const set = new Set<string>([ADDR.USDG.toLowerCase()]);
const symbols = new Map<string, string>([[ADDR.USDG.toLowerCase(), 'USDG']]);

export const isQuoteToken = (a: string): boolean => set.has(a.toLowerCase());
export const quoteSymbol = (a: string): string => symbols.get(a.toLowerCase()) ?? a.slice(0, 8);
export function addQuoteTokens(list: { address: string; symbol?: string }[]): number {
  let n = 0;
  for (const t of list) {
    const a = t.address.toLowerCase();
    if (!set.has(a)) n++;
    set.add(a);
    if (t.symbol) symbols.set(a, t.symbol);
  }
  return n;
}
export const quoteTokenCount = () => set.size;
