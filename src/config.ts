import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const address = z.string().refine((a) => ethers.isAddress(a), { message: 'gecersiz adres' }).transform((a) => ethers.getAddress(a));
const pct = z.number().min(0).max(100);

// Satis kurallari: strateji basina tam bir kural seti
export const SellRulesSchema = z.object({
  stopLossPct: pct.default(30),
  takeProfit: z.array(z.object({ gainPct: z.number().positive(), sellPct: pct })).default([{ gainPct: 100, sellPct: 50 }, { gainPct: 300, sellPct: 50 }]),
  trailing: z.object({ enabled: z.boolean().default(true), activationGainPct: z.number().min(0).default(40), dropPct: pct.default(25) }).prefault({}),
  copySell: z.object({
    enabled: z.boolean().default(true),
    mode: z.enum(['all', 'proportional']).default('all'),
    minWalletSellPct: pct.default(5),
    onTransferOut: z.boolean().default(true),
    onLiquidityRemove: z.boolean().default(true),
    onlySourceWallet: z.boolean().default(false),
  }).prefault({}),
  // Piyasa degerine (MC, $) gore kademeli satis: MC bu seviyeye ulasinca kalanin %sellPct'i satilir (her seviye bir kez)
  takeProfitMc: z.array(z.object({ mcUsd: z.number().positive(), sellPct: pct })).default([]),
  // MC tabani: piyasa degeri bu esigin ALTINDA kesintisiz N dakika kalirsa pozisyon kapatilir.
  // Amac: yerinde sayan tokenin slotu tikamasini onlemek, yeni lansmanlara yer acmak.
  mcFloor: z.object({
    enabled: z.boolean().default(false),
    mcUsd: z.number().min(0).default(10000),
    minutes: z.number().min(0.5).default(5),
  }).prefault({}),
  maxHoldMinutes: z.number().min(0).default(0),
  liquidityDrop: z.object({ enabled: z.boolean().default(true), dropPct: pct.default(50) }).prefault({}),
  slippagePct: pct.default(30),
  priceCheckIntervalMs: z.number().int().min(500).default(2000),
});

// Alim tarafi: strateji genel "buy" ayarlarini kismen ezebilir + sinyal turune gore alim anahtarlari
export const BuyOverridesSchema = z.object({
  amountEth: z.number().positive().optional(),
  mode: z.enum(['fixed', 'mirror']).optional(),
  mirrorPct: pct.optional(),
  maxAmountEth: z.number().positive().optional(),
  slippagePct: pct.optional(),
  signalMaxAgeSec: z.number().min(1).optional(),
  maxOpenPerStrategy: z.number().int().min(0).optional(),   // bu stratejinin ayni anda tutabilecegi en fazla pozisyon
  duplicateNameHours: z.number().min(0).optional(),
  // Taklit isim kurali SADECE onceki ayni isimli token bu MC uzerine ciktiysa uygulanir
  // (kullanicinin kurali: "ayni isimle basildiysa VE YUKSELDIYSE alma").
  duplicateNameMinMcUsd: z.number().min(0).optional(),        // taklit isim filtresi (koklu tokenlerde 0 = kapali)
  // Hikaye/sosyal filtresi (lansman): token'in zincirdeki aciklamasi veya Twitter linki olmali.
  // Olcum (64 pozisyon): ikisi de yoksa ort x0.956 (zarar); aciklama >=60 krk ise ort x1.208.
  requireStory: z.boolean().optional(),
  // true: SADECE aciklama uzunlugu sayilir (Twitter linki tek basina yetmez).
  // Olcum (71 lansman pozisyonu): aciklama>=60 -> 19 poz, %42 kazanan, net +0.00784 ETH
  //                               twitter VEYA aciklama>=60 -> 37 poz, %35 kazanan, net +0.00424 ETH
  //                               yani sadece-twitter grubu net -0.0036 ETH ile zarar ettiriyor.
  requireDescriptionOnly: z.boolean().optional(),
  minDescriptionLen: z.number().min(0).optional(),
  minCurveFillPct: z.number().min(0).optional(),           // PONS egrisi: en az bu kadar dolmus olmali (gercek talep sarti)
  maxCurveFillPct: z.number().min(0).optional(),           // ve bu kadardan fazla dolmamis olmali (mezuniyete cok yakinsa gec)
  // Cikis parasi filtresi: rota ETH/WETH karsiligi degilse (USDG gibi) alma.
  // Olcum (139 kapanmis pozisyon): USDG karsiligi 10 pozisyonun 10'u zarar etti, medyan x0.67;
  // dort ayri stratejide de ayni sonuc, yani strateji degil havuz kaynakli. ETH karsiligi: 61 poz, %41 kazanan.
  onlyEthQuoteRoute: z.boolean().optional(),
  // Havuz gec aciliyor: kullanicinin gozlemi ve olcum, likidite coin cikisindan ~60-90 sn SONRA ekleniyor.
  // Rota bulunamazsa hemen vazgecme, bu araliklarla tekrar tara.
  routeRetrySec: z.number().min(0).optional(),     // her denemede beklenecek saniye (0 = kapali)
  routeRetryCount: z.number().int().min(0).optional(), // kac kez tekrar taransin
  // ILK DAKIKA KALABALIGI: lansmanin ilk buyersWindowSec saniyesinde en az kac AYRI cuzdan
  // alim yapmis olmali. Zincir arastirmasi (5 kosan / 12 kontrol): kosanlar 7-13 alici,
  // kontrol 0-1. Fiyat tek cuzdanla oynatilir, alici sayisi oynatilamaz.
  minBuyers60s: z.number().int().min(0).optional(),
  buyersWindowSec: z.number().min(5).optional(),
  minEntryMcUsd: z.number().min(0).optional(),   // piyasa degeri ($) bunun altindaysa alma (0 = kapali)
  maxEntryMcUsd: z.number().min(0).optional(),   // piyasa degeri ($) bunun ustundeyse alma (0 = kapali)
  entryDelaySec: z.number().min(0).optional(),   // sinyal blogundan itibaren bu kadar saniye bekleyip sonra al (lansmanlarda sniper tepesinden almamak icin)
  minLaunchMult: z.number().min(0).optional(),   // lansman sinyalinde: alim aninda fiyat >= lansman fiyati x bu carpan degilse alma (momentum filtresi; 0 = kapali)
  maxLaunchMult: z.number().min(0).optional(),
  allowFlippers: z.boolean().optional(),          // bu strateji flip dedektorunu yok sayar (hizli al-sat cuzdanini bilerek kopyalarken)
  themeBlacklist: z.array(z.string()).optional(),   // sembol/ad bu kaliplardan birine uyuyorsa lansman alinmaz (doymus temalar)
  themeBoost: z.array(z.string()).optional(),       // guclu temalar: momentum esigi themeBoostMult ile carpilir (daha kolay giris)
  themeBoostMult: z.number().min(0.1).max(1).optional(),   // lansman sinyalinde: alim aninda fiyat <= lansman fiyati x bu carpan degilse alma (dip alimi icin ust sinir; 0 = kapali)
  copyBuys: z.boolean().default(true),           // cuzdan token alinca al
  buyOnLaunch: z.boolean().default(false),       // dev cuzdani hood.fun'da yeni token olusturunca hemen al
  buyOnLiquidityAdd: z.boolean().default(false), // dev cuzdani likidite ekleyince al
});

export const StrategySchema = z.object({
  label: z.string().default(''),
  description: z.string().default(''),
  buy: BuyOverridesSchema.prefault({}),
  sell: SellRulesSchema.prefault({}),
});

export const WalletSchema = z.object({
  address,
  label: z.string().default(''),
  enabled: z.boolean().default(true),
  kind: z.enum(['kol', 'dev', 'wallet']).default('wallet'),
  strategy: z.string().default('varsayilan'),
  note: z.string().default(''),
});

export const ConfigSchema = z.object({
  mode: z.enum(['paper', 'live']).optional(), // verilirse .env MODE'u ezer (panelden degistirilir)
  panel: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(1).max(65535).default(3777) }).prefault({}),
  trackedWallets: z.array(WalletSchema).default([]),
  strategies: z.record(z.string(), StrategySchema).default({}),

  buy: z.object({
    mode: z.enum(['fixed', 'mirror']).default('fixed'),
    amountEth: z.number().positive().default(0.01),
    mirrorPct: pct.default(10),
    maxAmountEth: z.number().positive().default(0.05),
    slippagePct: pct.default(15),
    // Cikis parasi: sadece ETH/WETH karsiligi havuzlardan al (USDG gibi havuzlar olcumde 10/10 zarar ettirdi).
    onlyEthQuoteRoute: z.boolean().default(true),
    minBuyers60s: z.number().int().min(0).default(0),
    buyersWindowSec: z.number().min(5).default(60),
    duplicateNameMinMcUsd: z.number().min(0).default(100000),
    routeRetrySec: z.number().min(0).default(0),
    routeRetryCount: z.number().int().min(0).default(0),
    maxOpenPositions: z.number().int().min(1).default(5),
    // Strateji basina acik pozisyon tavani (0 = sinirsiz). Cok sinyal ureten bir strateji
    // tum slotlari kapatip daha karli bacaklari disarida birakmasin diye.
    maxOpenPerStrategy: z.number().int().min(0).default(0),
    requireStory: z.boolean().default(false),
    requireDescriptionOnly: z.boolean().default(false),
    minDescriptionLen: z.number().min(0).default(60),
    minCurveFillPct: z.number().min(0).default(0),
    maxCurveFillPct: z.number().min(0).default(0),
    maxTotalExposureEth: z.number().positive().default(0.1),
    minWalletSpendEth: z.number().min(0).default(0.005),
    rebuyCooldownMin: z.number().min(0).default(60),
    signalMaxAgeSec: z.number().min(1).default(30),
    minEntryMcUsd: z.number().min(0).default(0),
    maxEntryMcUsd: z.number().min(0).default(0),
    entryDelaySec: z.number().min(0).default(0),
    minLaunchMult: z.number().min(0).default(0),
    maxLaunchMult: z.number().min(0).default(0),
    // Ayni isim/sembol son N saatte zaten lansman yaptiysa yeni olani alma (taklit lansmanlar). 0 = kapali
    duplicateNameHours: z.number().min(0).default(24),
    allowFlippers: z.boolean().default(false),
    themeBlacklist: z.array(z.string()).default([]),
    themeBoost: z.array(z.string()).default([]),
    themeBoostMult: z.number().min(0.1).max(1).default(0.85),
    // Lansman sinyali icin ikinci degerlendirme: bu strateji adi doluysa, lansman ayrica bu strateji ile (gecikmeli) degerlendirilir (dip alimi)
    dipStrategy: z.string().default(''),
    venues: z.array(z.enum(['bags', 'pons', 'v2', 'v3', 'v4', 'kyber'])).default(['bags', 'pons', 'v2', 'v3', 'v4', 'kyber']),
    copyTransfersIn: z.boolean().default(false),
    minTrackedWalletsAgree: z.number().int().min(1).default(1),
  }).prefault({}),

  sell: SellRulesSchema.prefault({}),

  safety: z.object({
    minLiquidityEth: z.number().min(0).default(0.3),
    maxRoundTripLossPct: pct.default(25),
    simulateRoundTrip: z.boolean().default(true),
    maxPoolFeePct: pct.default(5),
    tokenBlacklist: z.array(address).default([]),
    dailyMaxLossEth: z.number().min(0).default(0.05),
    reserveEth: z.number().min(0).default(0.005),
  }).prefault({}),

  // Tum launchpad'ler: PoolManager Initialize olaylarindan yeni havuz = yeni lansman sinyali (PONS, flap, pair.fund, digerleri)
  launchWatch: z.object({
    enabled: z.boolean().default(false),
    strategy: z.string().default('launch-momentum'),
    // Ayni lansman sinyali birden fazla stratejiye gonderilebilir: momentum bacagi hizli kar alir,
    // moonshot bacagi kucuk parayla girip x10'a kadar tutar. Ikisi ayni tokende de olabilir.
    extraStrategies: z.array(z.string()).default([]),

    onlyEthQuote: z.boolean().default(true),      // olcum: ETH karsiligi havuzlar belirgin daha iyi (ort x1.59 vs x1.31)
    hooks: z.array(z.string()).default([]),
    // Rug uretmis launchpad'ler: bu hook'lardan gelen lansmanlar hic alinmaz (beyaz liste degil, KARA liste)
    hookBlacklist: z.array(z.string()).default([]),
    // Rug dalgasi devre kesici: bir launchpad'de son penceredeki cokus sayisi esigi asarsa
    // o launchpad gecici olarak durdurulur (koordineli rug serilerine karsi).
    rugPauseCount: z.number().int().min(0).default(0),   // 0 = kapali
    rugWindowMin: z.number().min(1).default(30),
    rugPauseMin: z.number().min(1).default(30),
    allowNoHook: z.boolean().default(true),        // hook'suz sradan v4 havuzlari da izle (olcum: standart ucretlilerde ort x3.27)
    stdFees: z.array(z.number()).default([0, 100, 500, 3000, 10000]), // hook'suz havuzlarda sadece bu ucret kademeleri (tuhaf ucretliler tuzak)        // bos = hook'u olan tum havuzlar; dolu = sadece bu hook'lar
    maxAgeSec: z.number().min(10).default(120),
    // PONS egri lansmanlari: v4 havuzu ancak egri MEZUN olunca aciliyor (~51 bin dolar MC).
    // Asil dusuk MC girisi egri asamasinda (~3.5-9 bin dolar). Fabrika saatte ~700 lansman uretiyor.
    curveLaunches: z.boolean().default(false),
    curveStrategy: z.string().default('pons-egri-erken'),
  }).prefault({}),

  // Koklu token momentum akisi (yan sistem): derin havuzlu, hacimli, piyasada yeri olan tokenler.
  // Olcum: zirveye yakin 140 tokenin 12'si 24 saatte ikiye katlandi; zirveden %80+ dusmus
  // 254 tokenin sadece 2'si. Firsat dusmuslerde degil, hacmi olanlarda.
  mature: z.object({
    enabled: z.boolean().default(false),
    pollMs: z.number().int().min(30_000).default(120_000),
    strategy: z.string().default('koklu-momentum'),
    minReserveUsd: z.number().min(0).default(150_000),
    minVolume24hUsd: z.number().min(0).default(100_000),
    minChange1hPct: z.number().default(8),
    maxChange24hPct: z.number().default(300),
    maxDrawdownPct: z.number().default(80),
  }).prefault({}),

  // pair.fund lansman akisi (acik API): hisse tokeni karsiligi v4 havuzlarinda yeni tokenler
  pairFund: z.object({
    enabled: z.boolean().default(false),
    pollMs: z.number().int().min(3000).default(8000),
    strategy: z.string().default('pair-momentum'),
    maxAgeSec: z.number().min(30).default(600),
    requireTwitter: z.boolean().default(false),
    minDevBuyUsd: z.number().min(0).default(0),
  }).prefault({}),

  watch: z.object({
    pollIntervalMs: z.number().int().min(200).default(1500),
    maxCatchupBlocks: z.number().int().min(10).default(3000),
    startFromBlock: z.union([z.literal('latest'), z.number().int()]).default('latest'),
  }).prefault({}),

  gas: z.object({
    gasLimitMultiplier: z.number().min(1).default(1.3),
    priorityFeeGwei: z.number().min(0).default(0),
    maxFeeGwei: z.number().min(0).default(0),
    txTimeoutMs: z.number().int().min(5000).default(30000),
  }).prefault({}),
});

export type BotConfig = z.infer<typeof ConfigSchema>;
export type SellRules = z.infer<typeof SellRulesSchema>;
export type Strategy = z.infer<typeof StrategySchema>;
export type TrackedWallet = z.infer<typeof WalletSchema>;

export interface EffectiveStrategy {
  name: string;
  label: string;
  buy: BotConfig['buy'] & { copyBuys: boolean; buyOnLaunch: boolean; buyOnLiquidityAdd: boolean };
  sell: SellRules;
}

// Cuzdanin stratejisi + genel ayarlar -> o cuzdan icin gecerli alim/satis kurallari
export function resolveStrategy(cfg: BotConfig, name: string | undefined): EffectiveStrategy {
  const s = name ? cfg.strategies[name] : undefined;
  if (!s) return { name: 'varsayilan', label: 'Varsayilan', buy: { ...cfg.buy, copyBuys: true, buyOnLaunch: false, buyOnLiquidityAdd: false }, sell: cfg.sell };
  const ov: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.buy)) if (v !== undefined) ov[k] = v;
  return { name: name!, label: s.label || name!, buy: { ...cfg.buy, ...ov } as EffectiveStrategy['buy'], sell: s.sell };
}

export function walletEntry(cfg: BotConfig, addr: string): TrackedWallet | undefined {
  const a = addr.toLowerCase();
  return cfg.trackedWallets.find((w) => w.address.toLowerCase() === a);
}

// Etkin takip cuzdanlari: lowercase adres -> etiket
export function trackedMap(cfg: BotConfig): Map<string, string> {
  const m = new Map<string, string>();
  for (const w of cfg.trackedWallets) if (w.enabled && w.address !== ethers.ZeroAddress) m.set(w.address.toLowerCase(), w.label || w.address.slice(0, 6) + '..' + w.address.slice(-4));
  return m;
}

export function devWallets(cfg: BotConfig): string[] {
  return cfg.trackedWallets.filter((w) => w.enabled && w.kind === 'dev' && w.address !== ethers.ZeroAddress).map((w) => w.address.toLowerCase());
}

export interface Env {
  rpcHttpUrl: string;
  rpcWssUrl: string | undefined;
  privateKey: string | undefined;
  mode: 'paper' | 'live';
}

export function loadEnv(): Env {
  const mode = (process.env.MODE ?? 'paper').toLowerCase();
  if (mode !== 'paper' && mode !== 'live') throw new Error(`MODE sadece "paper" veya "live" olabilir, verilen: ${mode}`);
  const pk = process.env.PRIVATE_KEY?.trim() || undefined;
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('PRIVATE_KEY formati hatali (0x ile baslayan 64 hex karakter olmali)');
  return {
    rpcHttpUrl: process.env.RPC_HTTP_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com',
    rpcWssUrl: process.env.RPC_WSS_URL?.trim() || undefined,
    privateKey: pk,
    mode,
  };
}

let configPath = path.resolve('config.json');
export const getConfigPath = () => configPath;

export function parseConfig(raw: unknown): { ok: true; cfg: BotConfig } | { ok: false; errors: string[] } {
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) return { ok: false, errors: res.error.issues.map((i) => `${i.path.join('.') || '(kok)'}: ${i.message}`) };
  return { ok: true, cfg: res.data };
}

export function loadConfig(file = 'config.json'): BotConfig {
  configPath = path.resolve(file);
  if (!fs.existsSync(configPath)) throw new Error(`${file} bulunamadi. Ornek icin README'ye bak.`);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { throw new Error(`${file} JSON olarak okunamadi: ${(e as Error).message}`); }
  const res = parseConfig(raw);
  if (!res.ok) throw new Error(`${file} hatali:\n${res.errors.map((x) => '  - ' + x).join('\n')}`);
  return res.cfg;
}

export function saveConfig(cfg: BotConfig) {
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, configPath);
}
