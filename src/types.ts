export type VenueKind = 'bags' | 'pons' | 'v2' | 'v3' | 'v4' | 'kyber';

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

// Bir token icin alim/satim yapilabilecek somut yol (havuz / egri)
export interface Route {
  kind: VenueKind;
  token: string;           // checksum adres
  label: string;           // insan okunur: "Uniswap v3 1%", "hood.fun curve" ...
  pool?: string;           // v2 pair / v3 pool adresi
  fee?: number;            // v3 fee (100/500/3000/10000)
  poolId?: string;         // v4
  poolKey?: PoolKey;       // v4
  curve?: string;          // bags bonding curve adresi
  quoteIsNative?: boolean; // v4: karsi varlik native ETH (0x0) mu, WETH mi
  quoteToken?: string;     // v4: karsi varlik ETH/WETH degil de bir token ise (USDG): ETH bacagi Kyber ile eklenir
  lpLocked?: boolean;
  curveFillPct?: number;    // PONS egrisinde mezuniyet hedefinin yuzde kaci toplanmis (talep olcusu)      // launchpad havuzu (PONS/hood.fun hook): LP dev tarafindan cekilemez, likidite kurali uygulanmaz
}

// launch: takip edilen (dev) cuzdan hood.fun'da yeni token olusturdu
export type SignalType = 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'lp_remove' | 'lp_add' | 'launch';

export interface SignalHints {
  bagsCurve?: string;
  ponsCurve?: string;     // PONS launchpad bonding curve adresi
  v4PoolKeys?: PoolKey[]; // ayni islemde olusturulan v4 havuzlari (Initialize olayindan; RPC taramasi gerekmez)
  launchPriceEth?: bigint; // lansman fiyati (ETH / token, 1e18 olcekli) - ETH karsiligi v4 lansmanlarinda; momentum filtresi icin
  launchPriceQ?: bigint;   // lansman fiyati: karsi varligin en kucuk biriminden, 1e18 token basina (ETH: wei, USDG: 6 ondalik)
  launchQuote?: string;    // launchPriceQ'nun karsi varligi (0x0 = ETH)
  v4PoolIds: string[];
  v3Pools: string[];
  v2Pairs: string[];
  migrated?: boolean;      // bu tx icinde Bags egrisi Uniswap v4'e mezun oldu
}

// Takip edilen cuzdanin bir islemi icin uretilen sinyal
export interface Signal {
  type: SignalType;
  wallet: string;
  walletLabel: string;
  token: string;
  tokenAmount: bigint;     // cuzdana giren / cikan token miktari (wei)
  quoteAmount: bigint;     // ETH cinsinden harcanan / alinan (wei); bilinmiyorsa 0n
  quoteAsset: 'ETH' | 'OTHER';
  txHash: string;
  blockNumber: number;
  timestamp: number;       // blok zamani (saniye); bilinmiyorsa 0
  logIndex: number;
  hints: SignalHints;
  strategy?: string;   // sinyal kaynagi belirli bir strateji dayatiyorsa (ornek: pair.fund akisi); yoksa cuzdanin stratejisi
}

// Panel icin: sinyal + botun verdigi karar
export interface SignalRecord {
  time: number;
  type: SignalType;
  wallet: string;
  walletLabel: string;
  kind: string;            // kol | dev | wallet
  token: string;
  symbol: string;
  text: string;
  txHash: string;
  result: string;          // ALINDI / ATLA: sebep / ...
}

export interface TradeRecord {
  time: number;
  mode: string;
  side: 'BUY' | 'SELL';
  token: string;
  symbol: string;
  route: string;
  eth: string;
  tokens: string;
  tx: string;
  reason: string;
  pnlEth: string;
  strategy: string;
  // Giris anindaki olculebilir ozellikler (BUY satirlarinda dolu). Log yeniden baslatmada silindigi
  // icin kayip analizi bunlar olmadan yapilamiyordu; artik trades.csv'de kalici.
  mcUsd?: string;          // giristeki piyasa degeri
  launchMult?: string;     // lansman fiyatina gore kac kat
  liqEth?: string;         // havuz likiditesi (ETH)
  descLen?: string;        // token aciklamasinin karakter sayisi (hikaye filtresi analizi icin)
  rtLossPct?: string;      // al-sat (round-trip) maliyeti %
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply?: string;     // wei; piyasa degeri (MC) hesabi icin
}

export interface Position {
  id: string;
  token: string;
  symbol: string;
  decimals: number;
  route: Route;
  strategy: string;         // pozisyonu acan cuzdanin strateji adi (kurallar her fiyat kontrolunde buradan okunur)
  openedAt: number;         // ms
  openedBlock: number;
  openTx: string;
  sourceWallet: string;
  sourceLabel: string;
  costEth: string;          // toplam harcanan ETH (wei, string)
  tokensBought: string;     // wei
  tokensRemaining: string;  // wei
  realizedEth: string;      // satislardan gelen toplam ETH (wei)
  peakValueEth: string;     // kalan tokenlerin gordugu en yuksek deger (trailing icin)
  entryLiquidityEth: string;
  peakLiquidityEth: string;
  trailingActive: boolean;
  ladderDone: number[];     // uygulanan take-profit seviyelerinin indexleri
  ladderMcDone?: number[];  // uygulanan MC (piyasa degeri) seviyelerinin indexleri
  mcAboveAt?: number;       // piyasa degerinin MC tabani esigine SON ulastigi an (ms); esigin altinda ne kadar kaldigini olcer
  stuckSince?: number;      // hicbir venue kota veremediginde ilk tespit ani (ms); sikismis pozisyonu kapatmak icin
  liqDropTicks?: number;    // art arda kac fiyat kontrolunde likidite dususu goruldu (tek seferlik RPC hatasi satis tetiklemesin)
  slTicks?: number;
  slFirstAt?: number;       // ilk stop-loss kosulunun goruldugu an (ms); ani cokuslerde zaman bazli teyit icin         // art arda kac kontrolde stop-loss kosulu goruldu (ani %50+ cokuslerde teyit)
  sellLockUntil?: number;   // ms: bu zamana kadar satis kurallari uygulanmaz (launchpad erken alici satis kilidi; paper gercekciligi)
  lastValueEth: string;
  lastPriceCheck: number;
  supply?: string;          // token toplam arzi (wei)
  mcUsdAtEntry?: number;    // alis anindaki piyasa degeri ($)
  lastMcUsd?: number;       // son olculen piyasa degeri ($)
  peakMcUsd?: number;
  status: 'open' | 'closed';
  closedAt?: number;
  closeReason?: string;
  paper: boolean;
}

export interface PriceTick {
  valueEth: bigint;         // kalan tokenlerin su anki satis degeri (fiyat etkisi dahil)
  liquidityEth: bigint;     // havuzun ETH tarafi derinligi; <= 0 = bilinmiyor (kural atlanir)
  now: number;              // ms
  mcUsd?: number;           // piyasa degeri ($); bilinmiyorsa undefined
}

export interface SellDecision {
  fraction: number;         // 0..1 arasi, kalan tokenlerin ne kadari satilacak
  reason: string;
  ladderIndex?: number;     // tetiklenen carpan seviyesi (en yuksek)
  ladderMcIndex?: number;   // tetiklenen MC seviyesi (en yuksek)
  ladderAll?: number[];     // ayni anda tetiklenen tum carpan seviyeleri
  ladderMcAll?: number[];   // ayni anda tetiklenen tum MC seviyeleri
}
