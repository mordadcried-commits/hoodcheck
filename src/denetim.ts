// TOKEN DENETIMI - zincir disi kaynaklardan gelen sahiplik/dagilim bilgileri.
//
// Neyi GOSTERIYORUZ, neyi GOSTERMIYORUZ:
//   Gosterilir  : holder sayisi, top-10 yogunlugu, dev payi, kod dogrulanmis mi, sahip fonksiyonu.
//   Gosterilmez : Insiders / Phishing / Bundler / Dex Paid. Bu alanlar GMGN'in kendi cuzdan
//                 etiketlemesinden geliyor ve Robinhood zincirinde YOK. Bilinmeyeni "%0" diye
//                 gostermek uyari amacli bir araçta sahte guven verir; bos birakiyoruz.
//
// PUANA ETKISI YOK: dev payini kendi kapanmis islemlerimizde olctuk (08.09.2026, 12 rug / 12
// kazanan) ve AYRIM YAPMADI - rug medyani %0.00, kazanan medyani %0.00, kazananlarin ortalamasi
// daha yuksekti (IBM %52, DUMOCRATS %44, MANTA %43 - ucu de kazandi). Olcum ayrica gecmise
// donuk kirli: rug'in gelistiricisi zaten satmis oldugu icin bugun %0 gorunuyor. Bu yuzden
// sayilar bilgi olarak gosterilir, puani dusurmez. Ileriye donuk veri birikince yeniden bakilir.
import { ethers } from 'ethers';
import type { Chain } from './rpc.js';
import { log } from './logger.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const RS = 'https://robinscan.io/api';

export interface Denetim {
  holderSayisi?: number;
  transferSayisi?: number;
  top10Pay?: number;        // sozlesmeler (havuzlar) haric, 0-1
  enBuyukPay?: number;      // tek cuzdanin en buyuk payi, 0-1
  devPay?: number;          // olusturan cuzdanin elindeki oran, 0-1
  devAdres?: string;
  kodDogrulanmis?: boolean;
  sahipVar?: boolean;       // owner() fonksiyonu var mi (yoksa devredilecek sahiplik de yok)
  isaretli?: boolean;       // gezginin kendi dolandiricilik isareti
  launchpad?: string;       // pons, pair.fund vb.
  mezunMu?: boolean;        // egri lansmanini tamamlamis mi
  alimVergisiBps?: number;  // launchpad'in bildirdigi alim vergisi (varsa)
  satimVergisiBps?: number;
  likiditeKilitli?: boolean;
  kaynakHatasi?: string[];
}

const erc20 = new ethers.Interface([
  'function owner() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

// Blockscout araliksiz 500 dondurebiliyor (olculdu: ayni uc bir cagirida 200, digerinde 500).
// Tek deneme yeterli degil; kisa bir bekleyisle bir kez daha denenir.
async function jget(url: string, timeoutMs = 4000, deneme = 2): Promise<unknown | null> {
  for (let i = 0; i < deneme; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return await r.json();
    } catch { /* zaman asimi veya ag */ }
    if (i + 1 < deneme) await new Promise((f) => setTimeout(f, 450));
  }
  return null;
}

async function cagir(chain: Chain, adres: string, fn: string, args: unknown[] = []): Promise<unknown | null> {
  try {
    const r = await chain.publicProvider.call({ to: adres, data: erc20.encodeFunctionData(fn, args) });
    if (!r || r === '0x') return null;
    return erc20.decodeFunctionResult(fn, r)[0];
  } catch { return null; }
}

export async function tokenDenetimi(chain: Chain, token: string): Promise<Denetim> {
  const d: Denetim = { kaynakHatasi: [] };
  const adres = ethers.getAddress(token);

  // KAYNAK SECIMI (08.09.2026 olculdu):
  //   robinscan  /api/tokens/{a}          -> 386 ms, holderCount + sourceVerified + flagged
  //   blockscout /api/v2/addresses/{a}    -> 7100 ms sonra 500 (bozuk)
  //   blockscout /api/v2/tokens/{a}/holders -> 4600 ms (yavas ama is_contract isareti VAR)
  //   robinscan  /api/tokens/{a}/holders  -> 224 ms (hizli ama is_contract isareti YOK)
  // Bu yuzden: temel bilgi robinscan'den, holder dagilimi once robinscan (hizli) sonra
  // blockscout (sozlesme isareti icin) denenir.

  const temel = await jget(`${RS}/tokens/${adres}`) as {
    holderCount?: number; transferCount?: number; sourceVerified?: boolean; flagged?: boolean;
    launchpad?: { provider?: string; creator?: string; graduated?: boolean; buyTaxBps?: number | null;
                  sellTaxBps?: number | null; lockedPosition?: unknown };
  } | null;
  if (temel) {
    if (typeof temel.holderCount === 'number') d.holderSayisi = temel.holderCount;
    if (typeof temel.transferCount === 'number') d.transferSayisi = temel.transferCount;
    if (typeof temel.sourceVerified === 'boolean') d.kodDogrulanmis = temel.sourceVerified;
    if (typeof temel.flagged === 'boolean') d.isaretli = temel.flagged;
    // launchpad DUZ METIN DEGIL, nesne: icinde olusturan cuzdan, vergi oranlari ve kilit bilgisi var.
    const lp = temel.launchpad;
    if (lp && typeof lp === 'object') {
      if (lp.provider) d.launchpad = String(lp.provider);
      if (lp.creator) d.devAdres = String(lp.creator);
      if (typeof lp.graduated === 'boolean') d.mezunMu = lp.graduated;
      if (typeof lp.buyTaxBps === 'number') d.alimVergisiBps = lp.buyTaxBps;
      if (typeof lp.sellTaxBps === 'number') d.satimVergisiBps = lp.sellTaxBps;
      if (lp.lockedPosition !== undefined && lp.lockedPosition !== null) d.likiditeKilitli = true;
    }
  } else d.kaynakHatasi!.push('token bilgisi');

  // --- sahiplik: bu zincirdeki lansman sozlesmelerinde owner() genelde HIC YOK ---
  d.sahipVar = (await cagir(chain, adres, 'owner')) !== null;

  const arz = await cagir(chain, adres, 'totalSupply') as bigint | null;

  // --- yogunlasma ---
  // DIKKAT: en buyuk "holder" cogu zaman likidite havuzunun kendisidir (sozlesme). Sayarsak
  // her token yogun gorunur; ayiklamak icin adresin kodu var mi diye bakariz.
  const rs = await jget(`${RS}/tokens/${adres}/holders`) as { items?: { holder?: string; share?: number }[] } | null;
  const liste = rs?.items;
  if (liste?.length) {
    const adaylar = liste.filter((h) => h.holder && typeof h.share === 'number').slice(0, 16);
    const kodlar = await Promise.all(adaylar.map((h) => chain.publicProvider.getCode(h.holder!).catch(() => '0x')));
    const kisiler = adaylar.filter((_, i) => !kodlar[i] || kodlar[i] === '0x');
    const paylar = kisiler.map((h) => h.share!).sort((a, b) => b - a);
    if (paylar.length) {
      d.enBuyukPay = paylar[0];
      d.top10Pay = paylar.slice(0, 10).reduce((s, v) => s + v, 0);
    }
    // dev payi: olusturan adres yukarida launchpad nesnesinden geldi. Gelmediyse blockscout'u
    // bir kez dene (o uc 08.09'da 7 sn sonra 500 donuyordu, bu yuzden kisa zaman asimi).
    if (!d.devAdres) {
      const bilgi = await jget(`${BS}/addresses/${adres}`, 3000, 1) as { creator_address_hash?: string } | null;
      if (bilgi?.creator_address_hash) d.devAdres = bilgi.creator_address_hash;
    }
    if (d.devAdres && arz && arz > 0n) {
      const bakiye = await cagir(chain, adres, 'balanceOf', [d.devAdres]) as bigint | null;
      if (bakiye !== null) d.devPay = Number((bakiye * 1_000_000n) / arz) / 1_000_000;
    }
  } else d.kaynakHatasi!.push('holder dagilimi');

  if (!d.kaynakHatasi!.length) delete d.kaynakHatasi;
  else log.debug(`denetim ${adres.slice(0, 10)}: okunamayan kaynak(lar) ${d.kaynakHatasi!.join(', ')}`);
  return d;
}
