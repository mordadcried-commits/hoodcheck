import type { Chain } from '../rpc.js';
import type { Route, SignalHints, VenueKind } from '../types.js';

export interface ApprovalNeed { kind: 'erc20' | 'permit2'; token: string; spender: string; amount: bigint; }
// wrap: ETH -> WETH; tx: ana islemden once (prep) veya sonra (post) gonderilecek ayri bir islem (ornek: Kyber ile ETH <-> USDG bacagi)
export type PrepStep = { kind: 'wrap'; amount: bigint } | { kind: 'tx'; label: string; to: string; data: string; value: bigint; approvals?: ApprovalNeed[] };
export interface TxPlan { to: string; data: string; value: bigint; approvals: ApprovalNeed[]; prep: PrepStep[]; post?: PrepStep[]; }

export interface Venue {
  kind: VenueKind;
  findRoutes(chain: Chain, token: string, hints?: SignalHints): Promise<Route[]>;
  quoteBuy(chain: Chain, route: Route, ethIn: bigint): Promise<bigint>;     // alinacak token miktari
  quoteSell(chain: Chain, route: Route, tokensIn: bigint): Promise<bigint>; // alinacak ETH
  liquidityEth(chain: Chain, route: Route): Promise<bigint>;               // havuzun ETH tarafi derinligi; -1n = olculemiyor (bilinmiyor)
  spotPriceEth?(chain: Chain, route: Route): Promise<bigint>;              // 1 token (1e18) icin ETH (wei), ucretsiz anlik fiyat; yoksa kota ile tahmin edilir
  poolFeePct(chain: Chain, route: Route): Promise<number>;
  buildBuy(chain: Chain, route: Route, ethIn: bigint, minOut: bigint, recipient: string, deadline: number): Promise<TxPlan>;
  buildSell(chain: Chain, route: Route, tokensIn: bigint, minOut: bigint, recipient: string, deadline: number): Promise<TxPlan>;
}
