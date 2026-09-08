// TOKEN RISK RAPORU — Robinhood Chain
//
// Neden var: bu zincirde satis simulasyonu yapan bir servis YOK.
//   GoPlus 4663'u destekliyor ama buy_tax/sell_tax alanlarini BOS donduruyor,
//   is_honeypot cogu tokende undefined; Honeypot.is "Invalid chain" diyor;
//   Rugcheck sadece Solana. (08.09.2026'da tek tek olculdu.)
// Bizim elimizde zaten calisan bir al-sat simulasyonu var; rapor onu merkeze alir.
import { ethers } from 'ethers';
import { chainClock, type Chain } from './rpc.js';
import { ADDR, TOPICS } from './constants.js';
import { getTokenInfo, getTotalSupply } from './tokens.js';
import { discoverRoutes, bestBuyRoute } from './venues/index.js';
import { simulateRoundTrip } from './safety.js';
import { routeMarketCapUsd } from './priceFeed.js';
import { tokenSocial } from './social.js';
import { log } from './logger.js';
import type { Denetim } from './denetim.js';

// kod: dilden bagimsiz bulgu kimligi (arayuz TR/EN metnini kendisi uretir)
// baslik/aciklama: dogrudan API kullananlar icin Turkce metin
export class TokenDegil extends Error {
  constructor(public adres: string) { super(`${adres} bu zincirde bir token gibi gorunmuyor`); this.name = 'TokenDegil'; }
}

export interface RiskItem { seviye: 'kritik' | 'uyari' | 'bilgi' | 'iyi'; kod: string; deger?: Record<string, string | number>; baslik: string; aciklama: string }
export interface TokenReport {
  adres: string; sembol: string; ad: string; ondalik: number;
  puan: number; ozet: string;
  mcUsd?: number; likiditeEth?: number; toplamArz?: string;
  rota?: string; karsiPara?: string; karsiParaTipi?: 'ETH' | 'USDG' | 'hisse' | 'diger';
  satilabilir?: boolean; alSatMaliyetiPct?: number; simulasyonNotu?: string;
  ilkDakikaAlici?: number; lansmanBloku?: number; havuzSayisi?: number; yasSaat?: number;
  ayniSembolAdet?: number;
  aciklamaUzunlugu?: number; twitterVar?: boolean;
  denetim?: Denetim;
  riskler: RiskItem[];
  olcumMs: number;
}

const BLOK_SANIYE = 34_600 / 3600;   // ~9.6 blok/saniye (101 ms blok)
// DIKKAT (olculdu 08.09): genel RPC genis getLogs sorgularini SESSIZCE KIRPIYOR. Ayni aralik
// tek cagrida 2 havuz, parcalara bolununce 115 havuz donduruyor - hata da vermiyor. Bu yuzden
// "hata alinca bol" yetmez; parca boyu bastan kucuk tutulur. Dogus blogu bilindigi icin
// taranacak aralik zaten dar (token dogmadan once havuzu olamaz).
const TARAMA_PARCA = 2_000_000;

// Sozlesmenin dogus blogu: getCode bir blokta bos donuyorsa sozlesme o an henuz yoktur.
// Ikili arama ile ~26 hizli sorguda bulunur. Bunu bilmek havuz taramasini tum zincir yerine
// "dogustan bugune" araligiyla sinirlar; HAMSTR'da ilk tarama 65 sn suruyordu.
const dogusOnbellek = new Map<string, number>();
export async function dogusBlogu(chain: Chain, adres: string, head: number): Promise<number> {
  const anahtar = adres.toLowerCase();
  const bilinen = dogusOnbellek.get(anahtar);
  if (bilinen !== undefined) return bilinen;

  // ARSIV GEREKIR: genel RPC gecmis bloklarda getCode'u REDDEDIYOR (olculdu 08.09: 100 bin
  // blok geride "could not coalesce error"). Hatayi "sozlesme henuz yok" saymak aramayi
  // sessizce bozuyordu -- CLAN'in 115 havuzu 0 gorunuyordu. Bu yuzden:
  //   - sorgu chain.provider'a (Alchemy, arsiv) gider,
  //   - hata alinirsa arama IPTAL edilir ve 0 donulur (tum zincir taranir, yavas ama dogru).
  const varMi = async (b: number): Promise<boolean | null> => {
    try {
      const kod = await chain.provider.getCode(adres, b);
      return !!kod && kod !== '0x';
    } catch { return null; }        // okunamadi != yok
  };

  if ((await varMi(head)) !== true) return 0;
  let lo = 0, hi = head;
  while (hi - lo > 1) {
    const orta = Math.floor((lo + hi) / 2);
    const v = await varMi(orta);
    if (v === null) return 0;       // arsiv yok: bastan tara
    if (v) hi = orta; else lo = orta;
  }
  dogusOnbellek.set(anahtar, hi);
  if (dogusOnbellek.size > 2000) dogusOnbellek.clear();
  return hi;
}

const havuzOnbellek = new Map<string, { at: number; tam: boolean; liste: { pool: string; blok: number; karsi: string }[] }>();

async function tumV4Havuzlari(chain: Chain, token: string): Promise<{ liste: { pool: string; blok: number; karsi: string }[]; tam: boolean }> {
  const anahtar = token.toLowerCase();
  const eski = havuzOnbellek.get(anahtar);
  if (eski && Date.now() - eski.at < 30 * 60_000) return { liste: eski.liste, tam: eski.tam };
  const T = ethers.zeroPadValue(token.toLowerCase(), 32);
  const head = await chain.publicProvider.getBlockNumber();

  // Genis aralikli sorgu 10.000 SONUC sinirina takilabilir (USDG gibi binlerce havuzda gecen
  // tokenlerde oluyor). Hata alinca araligi ikiye bol; bos donerse oldugu gibi kabul et.
  const tara = async (lo: number, hi: number, pos: number, derinlik = 0): Promise<ethers.Log[]> => {
    const topics: (string | null)[] = [TOPICS.V4_INITIALIZE, null, null, null];
    topics[pos] = T;
    try {
      return await chain.publicProvider.getLogs({ address: ADDR.UNI_V4_POOL_MANAGER, topics, fromBlock: lo, toBlock: hi });
    } catch (e) {
      if (derinlik >= 6 || hi - lo < 50_000) { log.debug(`havuz taramasi ${lo}-${hi} basarisiz: ${(e as Error).message.slice(0, 60)}`); return []; }
      const orta = Math.floor((lo + hi) / 2);
      return [...await tara(lo, orta, pos, derinlik + 1), ...await tara(orta + 1, hi, pos, derinlik + 1)];
    }
  };

  // Havuzlar token dogmadan once acilamaz: taramayi dogus blogundan baslat.
  const dogus = await dogusBlogu(chain, token, head).catch(() => 0);

  // ILERI TARAMA + ERKEN DURMA. Lansman olcumu icin gereken sey tokenin EN ESKI havuzlaridir;
  // sonradan acilan yuzlerce havuz o pencereyi degistirmez. Dogustan ileri dogru tarayip ilk
  // dolu parcada duruyoruz: CLAN'da 12 sorgu yerine 2 sorgu.
  // Paralel calistirmayi denedim, GERI ALDIM: genel RPC 4 escagrida bozuluyor (CLAN hata
  // verdi, ROUTE 0 havuz dondu). Sirali kalmasi dogruluk icin sart.
  const ham: ethers.Log[] = [];
  let tamTarandi = true;
  for (let lo = dogus; lo < head; lo += TARAMA_PARCA) {
    const hi = Math.min(head, lo + TARAMA_PARCA);
    for (const pos of [2, 3]) ham.push(...await tara(lo, hi, pos));
    if (ham.length) { tamTarandi = hi >= head; break; }   // en eski havuzlar bulundu
  }

  const liste = ham
    .map((l) => ({ pool: l.topics[1], blok: l.blockNumber, karsi: '0x' + (l.topics[2] === T ? l.topics[3] : l.topics[2]).slice(26) }))
    .sort((a, b) => a.blok - b.blok);
  havuzOnbellek.set(anahtar, { at: Date.now(), liste, tam: tamTarandi });
  if (havuzOnbellek.size > 600) for (const [k, v] of havuzOnbellek) if (Date.now() - v.at > 60 * 60_000) havuzOnbellek.delete(k);
  return { liste, tam: tamTarandi };
}

// Verilen havuzlarda [lo, hi] araligindaki Swap loglari. Sonuc siniri asilirsa once havuz
// grubunu, sonra blok araligini ikiye boler. Hicbir sekilde okunamazsa null doner (olculemedi).
async function swapTara(chain: Chain, havuzlar: string[], lo: number, hi: number, derinlik = 0): Promise<ethers.Log[] | null> {
  if (!havuzlar.length) return [];
  try {
    return await chain.publicProvider.getLogs({ address: ADDR.UNI_V4_POOL_MANAGER, topics: [TOPICS.V4_SWAP, havuzlar], fromBlock: lo, toBlock: hi });
  } catch (e) {
    if (derinlik >= 7) { log.debug(`swap taramasi ${lo}-${hi} (${havuzlar.length} havuz) basarisiz: ${(e as Error).message.slice(0, 60)}`); return null; }
    if (havuzlar.length > 1) {
      const orta = Math.ceil(havuzlar.length / 2);
      const a = await swapTara(chain, havuzlar.slice(0, orta), lo, hi, derinlik + 1);
      const b = await swapTara(chain, havuzlar.slice(orta), lo, hi, derinlik + 1);
      return a === null || b === null ? null : [...a, ...b];
    }
    if (hi - lo < 200) return null;
    const om = Math.floor((lo + hi) / 2);
    const a = await swapTara(chain, havuzlar, lo, om, derinlik + 1);
    const b = await swapTara(chain, havuzlar, om + 1, hi, derinlik + 1);
    return a === null || b === null ? null : [...a, ...b];
  }
}

const HISSE_QUOTE = new Set<string>();  // pair.fund / PONS hisse quote'lari calisma aninda dolar

export async function tokenReport(chain: Chain, tokenAdres: string, ayniSembolSayaci?: (sym: string) => number): Promise<TokenReport> {
  const t0 = Date.now();
  const adres = ethers.getAddress(tokenAdres);
  const riskler: RiskItem[] = [];
  // Adres bir ERC-20 degilse (cuzdan, sozlesme, bos adres) net soyle; 500 dondurmek
  // kullaniciya "site bozuk" hissi verir, oysa girdi yanlis.
  const info = await getTokenInfo(chain, adres).catch(() => null);
  if (!info || !info.symbol) throw new TokenDegil(adres);

  const r: TokenReport = {
    adres, sembol: info.symbol, ad: info.name, ondalik: info.decimals,
    puan: 50, ozet: '', riskler, olcumMs: 0,
  };

  // Denetim verisi dis kaynaklardan geliyor (Blockscout/robinscan); zincir taramasiyla
  // PARALEL calistir ki toplam sure uzamasin.
  // --- 1) Rota ve likidite ---
  const routes = await discoverRoutes(chain, adres, ['bags', 'v2', 'v3', 'v4', 'kyber'] as never, undefined).catch(() => []);
  if (!routes.length) {
    riskler.push({ seviye: 'kritik', kod: 'havuz-yok', baslik: 'Alinabilir havuz yok', aciklama: 'Bu token icin likidite bulunamadi. Ne alinabilir ne satilabilir.' });
    r.puan = 0; r.ozet = 'ISLEM GOREMEZ'; r.olcumMs = Date.now() - t0;
    return r;
  }
  const probe = ethers.parseEther('0.002');
  const best = await bestBuyRoute(chain, routes, probe).catch(() => null);
  if (best) {
    r.rota = best.route.label;
    const q = best.route.quoteToken;
    if (!q || /^0x0{40}$/i.test(q) || q.toLowerCase() === ADDR.WETH.toLowerCase()) { r.karsiPara = 'ETH'; r.karsiParaTipi = 'ETH'; }  // v4'te yerel ETH = adres(0)
    else {
      const qs = await getTokenInfo(chain, q).catch(() => null);
      r.karsiPara = qs?.symbol ?? q.slice(0, 8);
      r.karsiParaTipi = qs && /USDG|USDC|USDT/i.test(qs.symbol) ? 'USDG' : (HISSE_QUOTE.has(q.toLowerCase()) ? 'hisse' : 'diger');
    }
    r.mcUsd = await routeMarketCapUsd(chain, best.route, info.decimals, { ethOut: probe, tokensIn: best.tokensOut }).catch(() => undefined);
  }

  // --- 2) SATIS SIMULASYONU (bu zincirde baska kimsenin yapmadigi kisim) ---
  // Uc ayri hata sinifini karistirmamak sart, yoksa masum tokene honeypot damgasi vururuz:
  //   ALIM patlarsa            -> rota/kodlama sorunu, token hakkinda hicbir sey soylemez.
  //   TEK rotada satis patlarsa-> genelde onay (allowance) veya router sorunu. CLAN'da tam bunu
  //                               gorduk: Kyber rotasinda TRANSFER_FROM_FAILED, dogrudan v4
  //                               havuzunda ise satis sorunsuz calisiyor.
  //   HER rotada satis patlarsa-> gercek honeypot suphesi. Tuzak her yerde tuzaktir.
  if (best) {
    const alimSorunu = (x: { ok: boolean; reason?: string } | null) =>
      !!x && !x.ok && /ALIM revert|on adimi revert|bakiyesi 0|calistirilamadi/i.test(x.reason ?? '');

    // Denenecek rotalar: once en iyi kota, sonra digerleri (kyber en sona - onay sorunu en cok orada)
    const sira = [best.route, ...routes.filter((x) => x !== best.route)]
      .sort((a, b) => (a === best.route ? -1 : b === best.route ? 1 : (a.kind === 'kyber' ? 1 : 0) - (b.kind === 'kyber' ? 1 : 0)))
      .slice(0, 3);

    // ONAY SINIFI HATA != HONEYPOT. Olculdu 08.09: ROUTE ayni anda, ayni rotada 6 denemenin
    // 2'sinde "TransferHelper: TRANSFER_FROM_FAILED" veriyordu (%33) - token tamamen saglamdi,
    // oynak olan Kyber toplayici rotasiydi. Tek bir basarisizlikla honeypot demek, masum bir
    // projeye en agir damgayi vurmak olur. Bu yuzden onay sinifi hata TEKRARLANMADIKCA
    // sayilmaz: ayni rota iki kez daha denenir.
    const onaySinifi = (x: { reason?: string }) => /TRANSFER_FROM_FAILED|TransferHelper|allowance|STF/i.test(x.reason ?? '');

    let basarili: Awaited<ReturnType<typeof simulateRoundTrip>> | null = null;
    let satisRevert: Awaited<ReturnType<typeof simulateRoundTrip>> | null = null;
    let sonAlimSorunu: Awaited<ReturnType<typeof simulateRoundTrip>> | null = null;
    for (const rota of sira) {
      let sim = await simulateRoundTrip(chain, rota, info, probe).catch(() => null);
      for (let d = 0; d < 2 && sim && !sim.ok && !alimSorunu(sim) && onaySinifi(sim); d++) {
        await new Promise((f) => setTimeout(f, 700));
        const tekrar = await simulateRoundTrip(chain, rota, info, probe).catch(() => null);
        if (tekrar) sim = tekrar;
      }
      if (!sim) continue;
      if (sim.ok) { basarili = sim; r.rota = rota.label; break; }
      if (alimSorunu(sim)) { sonAlimSorunu = sim; continue; }
      satisRevert = satisRevert ?? sim;   // ilk gercek satis reverti hatirla, digerlerini de dene
    }

    if (basarili) {
      r.satilabilir = true;
      r.alSatMaliyetiPct = basarili.lossPct;
      r.simulasyonNotu = basarili.reason;
      const p = basarili.lossPct;
      // %50 ustu kayip pratikte honeypot ile aynidir: satis teknik olarak GECER ama paraniz geri
      // gelmez. SNC (adi "Scamnance") bir calistirmada satis reverti, digerinde %99.4 kayip verdi;
      // ikisi de olumcul, ikisi de kirmizi olmali.
      if (p >= 50) riskler.push({ seviye: 'kritik', kod: 'maliyet-olumcul', deger: { pct: p }, baslik: `Satista paranin %${p.toFixed(0)}'i yok oluyor`, aciklama: 'Satis islemi geciyor ama elinize neredeyse hicbir sey gecmiyor. Pratikte honeypot ile ayni sonuc.' });
      else if (p >= 15) riskler.push({ seviye: 'uyari', kod: 'maliyet-yuksek', deger: { pct: p }, baslik: `Al-sat maliyeti yuksek: %${p.toFixed(1)}`, aciklama: 'Alip hemen satsaniz bu kadarini kaybedersiniz. Yuksek vergi veya ince havuz.' });
      else if (p >= 6) riskler.push({ seviye: 'bilgi', kod: 'maliyet-orta', deger: { pct: p }, baslik: `Al-sat maliyeti %${p.toFixed(1)}`, aciklama: 'Normalin ustunde ama olumcul degil.' });
      else riskler.push({ seviye: 'iyi', kod: 'satilabilir', deger: { pct: p }, baslik: `Satilabiliyor, al-sat maliyeti %${p.toFixed(1)}`, aciklama: 'Simulasyonda alim ve satim basarili.' });
    } else if (satisRevert) {
      r.satilabilir = false;
      r.alSatMaliyetiPct = satisRevert.lossPct;
      r.simulasyonNotu = satisRevert.reason;
      const sebep = String(satisRevert.reason ?? '').slice(0, 180);
      riskler.push({ seviye: 'kritik', kod: 'satilamaz', deger: { sebep, rota: sira.length }, baslik: 'SATILAMIYOR', aciklama: sebep || 'Denenen tum rotalarda satis islemi basarisiz oldu. Honeypot olabilir.' });
    } else if (sonAlimSorunu) {
      riskler.push({ seviye: 'uyari', kod: 'alim-basarisiz', deger: { sebep: String(sonAlimSorunu.reason ?? '').slice(0, 90) }, baslik: 'Satilabilirlik dogrulanamadi', aciklama: `Alim simulasyonu basarisiz oldu (${String(sonAlimSorunu.reason ?? '').slice(0, 90)}); bu tokenin satilamadigi anlamina GELMEZ, olcemedik demektir.` });
    } else {
      riskler.push({ seviye: 'uyari', kod: 'satis-olculemedi', baslik: 'Satilabilirlik dogrulanamadi', aciklama: 'Simulasyon calistirilamadi. Satabildiginizi teyit etmeden buyuk miktar girmeyin.' });
    }
  }

  // --- 3) Cikis parasi riski (bu zincire ozgu) ---
  if (r.karsiParaTipi === 'hisse' || (r.karsiParaTipi === 'diger' && r.karsiPara)) {
    riskler.push({
      seviye: 'uyari',
      kod: 'cikis-parasi',
      deger: { para: r.karsiPara ?? '' },
      baslik: `Cikis parasi ETH degil: ${r.karsiPara}`,
      aciklama: 'Sattiginizda ETH degil bu varligi alirsiniz; nakde donmek icin ikinci bir takas gerekir ve o havuz ince olabilir.',
    });
  }

  // --- 4) Ilk dakika kalabaligi (lansman kalitesi) ---
  // Bir tokenin ONLARCA v4 havuzu olabilir (CLAN 115, PINK 47). Iki tuzak var:
  //   a) rotadan gelen havuzu olcmek -> CLAN'da olu bir USDG havuzu secilip "0 alici" cikmisti,
  //   b) "en eski havuz = lansman" saymak -> CLAN'da gercek ETH havuzundan 568 blok once
  //      bos bir USDG havuzu acilmis, pencere lansmandan once bitiyordu.
  // Dogru tanim: ILK GERCEK ISLEM anindan itibaren 60 saniye, tum havuzlar birlikte.
  try {
    const { liste: havuzlar, tam } = await tumV4Havuzlari(chain, adres);
    // Havuz sayisi sadece TUM zincir tarandiysa bildirilir; erken durduysak eksik olurdu.
    if (tam) r.havuzSayisi = havuzlar.length;
    if (havuzlar.length) {
      const ilkInit = havuzlar[0].blok;
      // Yas her durumda burada belirlenir: swap bulunsun bulunmasin tokenin kac dakikalik
      // oldugunu bilmemiz sart (cok taze tokene "dusuk risk" demememiz buna bagli).
      const ilkBlok = await chain.publicProvider.getBlock(ilkInit).catch(() => null);
      if (ilkBlok) r.yasSaat = (chainClock.now() - ilkBlok.timestamp) / 3600;
      const pencere30dk = Math.ceil(1800 * BLOK_SANIYE);
      // Ilk 30 dakikada acilmis havuzlarin hepsini TEK sorguda tara (topics OR listesi)
      const adaylar = havuzlar.filter((h) => h.blok <= ilkInit + pencere30dk).map((h) => h.pool).slice(0, 60);
      // Yogun bir lansmanda 30 dakikalik pencere 10.000 sonuc sinirini asabilir; hem havuz
      // grubunu hem blok araligini bolerek tara (CLAN'da tek seferlik sorgu sessizce bosa dusuyordu).
      const kafa = await chain.publicProvider.getBlockNumber();
      const swapAra = async (bitis: number) => swapTara(chain, adaylar, ilkInit, Math.min(bitis, kafa));

      // MERDIVEN: bize sadece ILK 60 SANIYEDEKI alicilar lazim. Once dar bir pencereye bak;
      // canli bir lansmanda ilk islem saniyeler icinde olur ve is orada biter. 30 dakikayla
      // baslamak CLAN gibi yogun tokenlerde binlerce swap okutuyordu (Render'in 0.1 CPU'sunda
      // 50 sn zaman asimina takildi). Sadece sessiz tokenlerde pencere genisletilir.
      let swaplar = await swapAra(ilkInit + Math.ceil(120 * BLOK_SANIYE));          // 2 dakika
      if (swaplar && !swaplar.length) swaplar = await swapAra(ilkInit + pencere30dk);
      if (swaplar && !swaplar.length) swaplar = await swapAra(ilkInit + Math.ceil(6 * 3600 * BLOK_SANIYE));
      if (swaplar) {
        if (!swaplar.length) {
          r.lansmanBloku = ilkInit;
          // Pencere geriye donuk 6 saat: yeni acilmis bir havuzda "hic islem yok" demek haksizlik olur,
          // cunku o 6 saat henuz gecmedi. Sadece sure gercekten dolduysa bulgu yaz.
          const ib = await chain.publicProvider.getBlock(ilkInit).catch(() => null);
          const gecenSaat = ib ? (chainClock.now() - ib.timestamp) / 3600 : 999;
          if (ib) r.yasSaat = gecenSaat;
          if (gecenSaat >= 6) riskler.push({ seviye: 'kritik', kod: 'islem-yok', baslik: 'Hic islem gormemis', aciklama: 'Havuz acilmis ama ilk 6 saatte tek bir alim satim bile yok.' });
          else riskler.push({ seviye: 'bilgi', kod: 'cok-yeni', deger: { dk: Math.round(gecenSaat * 60) }, baslik: `Havuz ${Math.round(gecenSaat * 60)} dakika once acilmis, henuz islem yok`, aciklama: 'Degerlendirmek icin cok erken.' });
        } else {
          const t0 = Math.min(...swaplar.map((l) => l.blockNumber));    // ilk gercek islem
          const bitis = t0 + Math.ceil(60 * BLOK_SANIYE);
          const alicilar = new Set(swaplar.filter((l) => l.blockNumber <= bitis).map((l) => ('0x' + l.topics[2].slice(26)).toLowerCase()));
          r.lansmanBloku = t0;
          r.ilkDakikaAlici = alicilar.size;
          const blk = await chain.publicProvider.getBlock(t0).catch(() => null);
          if (blk) r.yasSaat = (chainClock.now() - blk.timestamp) / 3600;
          // NE KADAR AGIRLIK VERMELI: kendi botumuzda bu olcuyu 40 islemde filtre olarak denedik;
          // olculebilir bir kazanc vermedi ve iki buyuk kaciriga sebep oldu. Kalibrasyonda da
          // kazanan iki token (FloorPad x3.18, RBLE x3.58) bu yuzden haksiz yere kirmiziya
          // dusuyordu. Bu yuzden bilgi/uyari seviyesinde tutuluyor, karari o belirlemiyor.
          const taze = (r.yasSaat ?? 999) < 24;
          if (alicilar.size <= 1) riskler.push({ seviye: taze ? 'uyari' : 'bilgi', kod: 'alici-yok', deger: { n: alicilar.size }, baslik: `Ilk dakikada ${alicilar.size} cuzdan`, aciklama: 'Lansmanda gercek talep olusmamis; fiyat tek bir cuzdanla oynatilmis olabilir.' });
          else if (alicilar.size <= 3) riskler.push({ seviye: 'bilgi', kod: 'alici-az', deger: { n: alicilar.size }, baslik: `Ilk dakikada sadece ${alicilar.size} cuzdan`, aciklama: 'Zayif ilgi. Fiyat az sayida cuzdanla yonlendirilmis olabilir.' });
          else riskler.push({ seviye: 'iyi', kod: 'alici-iyi', deger: { n: alicilar.size }, baslik: `Ilk dakikada ${alicilar.size} ayri cuzdan islem yapmis`, aciklama: 'Lansmanda gercek ilgi olusmus.' });
        }
      }
    }
  } catch (e) {
    log.debug(`tokencheck ${adres}: lansman olcumu yapilamadi - ${(e as Error).message}`);
  }

  // --- 5) Ayni sembolu tasiyan baska token var mi (taklit riski) ---
  if (ayniSembolSayaci) {
    const n = ayniSembolSayaci(info.symbol);
    r.ayniSembolAdet = n;
    if (n >= 5) riskler.push({ seviye: 'uyari', kod: 'sembol-cok', deger: { n }, baslik: `Ayni sembolde ${n} farkli token var`, aciklama: 'Bu isim yogun sekilde taklit ediliyor. Adresi mutlaka dogrulayin.' });
    else if (n >= 2) riskler.push({ seviye: 'bilgi', kod: 'sembol-az', deger: { n }, baslik: `Ayni sembolde ${n} token`, aciklama: 'Adresi kontrol edin.' });
  }

  // --- 6) Hikaye/sosyal ---
  try {
    const soc = await tokenSocial(chain, adres);
    if (soc) {
      r.aciklamaUzunlugu = soc.descLen; r.twitterVar = soc.hasTwitter;
      if (soc.descLen === 0 && !soc.hasTwitter) riskler.push({ seviye: 'bilgi', kod: 'bilgi-yok', baslik: 'Zincirde hicbir bilgi yok', aciklama: 'Aciklama ve sosyal medya bagi bulunmuyor.' });
    }
  } catch { /* yoksay */ }

  // --- 7) Toplam arz ---
  try { const sup = await getTotalSupply(chain, adres); if (sup) r.toplamArz = ethers.formatUnits(sup, info.decimals); } catch { /* yoksay */ }

  // NOT: denetim (holder/dagilim/launchpad) BU CAGRIDA YAPILMAZ. Dis kaynaklar yavas oldugu
  // icin taramayi 90 sn'lik zaman asimina goturuyordu; ayri uca tasindi: GET /api/denetim.
  // Yas hala bilinmiyorsa (havuz sayimi bos donmus olabilir) sozlesmenin dogus blogundan
  // hesapla. Bu deger onbellekli, ek maliyeti yok. Yasi bilmeden "dusuk risk" diyemeyiz.
  if (r.yasSaat === undefined) {
    try {
      const kafa2 = await chain.publicProvider.getBlockNumber();
      const dg = await dogusBlogu(chain, adres, kafa2);
      if (dg > 0) {
        const db = await chain.publicProvider.getBlock(dg).catch(() => null);
        if (db) r.yasSaat = (chainClock.now() - db.timestamp) / 3600;
      }
    } catch { /* olculemedi */ }
  }

  // --- COK TAZE TOKEN UYARISI ---
  // Olculdu 08.09: saniyeler onceki lansmanlar 95-100 puan "DUSUK RISK" cikiyordu, cunku
  // soyleyecek kotu bir sey yoktu. Ama "henuz bilmiyoruz" ile "risk dusuk" ayni sey degildir;
  // bu, uyarmaya calistigimiz kisiyi tam ters yone iter. Simulasyon o anki satilabilirligi
  // gosterir, likidite bir sonraki blokta cekilebilir ve talep olusup olusmayacagi belirsizdir.
  const yasDk = (r.yasSaat ?? 999) * 60;
  if (yasDk < 15) {
    riskler.push({
      seviye: 'uyari', kod: 'cok-taze', deger: { dk: Math.max(0, Math.round(yasDk)) },
      baslik: `Bu token ${Math.max(0, Math.round(yasDk))} dakikalik`,
      aciklama: 'Simulasyon su an satilabildigini gosteriyor ama likidite bir sonraki blokta cekilebilir ve gercek talep olusup olusmayacagi henuz belli degil.',
    });
  }

  // --- PUAN ---
  let puan = 100;
  for (const x of riskler) {
    if (x.seviye === 'kritik') puan -= 55;
    else if (x.seviye === 'uyari') puan -= 18;
    else if (x.seviye === 'bilgi') puan -= 5;
  }
  r.puan = Math.max(0, Math.min(100, puan));
  // 15 dakikadan taze bir tokeni "dusuk risk" diye etiketlemeyiz: elimizde onu destekleyecek
  // gecmis yok. Tavan ORTA RISK'te tutulur (daha kotu bulgular varsa puan zaten asagida).
  if (yasDk < 15) r.puan = Math.min(r.puan, 70);
  r.ozet = r.puan >= 75 ? 'DUSUK RISK' : r.puan >= 45 ? 'ORTA RISK' : r.puan >= 20 ? 'YUKSEK RISK' : 'COK RISKLI';
  r.olcumMs = Date.now() - t0;
  return r;
}

// pair.fund / PONS hisse quote'larini kaydet (karsi para tipini dogru etiketlemek icin)
export function hisseQuoteEkle(adresler: string[]) { for (const a of adresler) HISSE_QUOTE.add(a.toLowerCase()); }
