// HOODCHECK - halka acik token risk tarayicisi (ayri surec, ayri port)
//
// NEDEN AYRI SUNUCU: bot paneli (src/panel/server.ts) private key girisi, canli mod anahtari
// ve alim-satim uclarini barindirir. O sunucuyu internete acmak cuzdanin bosaltilmasi demektir.
// Bu surec:
//   - CUZDAN ANAHTARI OKUMAZ (privateKey verilmez; simulasyonlar rastgele bos adresle calisir)
//   - pozisyon/islem/ayar dosyalarina DOKUNMAZ
//   - sadece iki uc sunar: GET /  ve  GET /api/tokencheck
// Boylece halka acik yuzey ile para tutan yuzey fiziksel olarak ayrilir.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, chainClock, type Chain } from './rpc.js';
import { tokenReport, TokenDegil, type TokenReport } from './tokencheck.js';
import { symbolCount } from './tokens.js';
import { tokenDenetimi, type Denetim } from './denetim.js';
import { log } from './logger.js';

const SAYFA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel', 'kontrol.html');
const PORT = Number(process.env.HOODCHECK_PORT || 8080);
const HOST = process.env.HOODCHECK_HOST || '127.0.0.1';   // canliya cikarken 0.0.0.0 verilir
const GENEL_RPC = 'https://rpc.mainnet.chain.robinhood.com';

// RPC SECIMI: genel RPC bedava ama eth_simulateV1'i hizli hizli isteyince 429 veriyor
// (08.09: bir tarama 17.9 sn surdu, cogu 429 beklemesiydi, sonra 90 sn'de zaman asimi).
// .env'de bir Alchemy HTTP adresi varsa onu ana provider yapariz: connect() genis getLogs
// taramalarini yine GENEL RPC'ye gonderir (publicProvider), sadece simulasyon Alchemy'e gider.
// ANAHTAR OKUNMAZ: sadece RPC_HTTP_URL alinir, PRIVATE_KEY'e hic bakilmaz.
function rpcSec(): string {
  // Yayin paketinde .env DOSYASI YOKTUR (bilerek: Alchemy anahtari sunucuya dosyayla
  // tasinmaz). Orada adres ortam degiskeniyle verilir.
  if (process.env.HOODCHECK_RPC) return process.env.HOODCHECK_RPC;
  if (process.env.RPC_HTTP_URL && /^https?:\/\//.test(process.env.RPC_HTTP_URL)) return process.env.RPC_HTTP_URL;
  try {
    for (const satir of fs.readFileSync(path.resolve('.env'), 'utf8').split(/\r?\n/)) {
      const m = satir.match(/^\s*RPC_HTTP_URL\s*=\s*(\S+)\s*$/);
      if (m && /^https?:\/\//.test(m[1])) return m[1];
    }
  } catch { /* .env yoksa genel RPC */ }
  return GENEL_RPC;
}
const RPC = rpcSec();

// --- limitler ---
const DAKIKA_HAK = 10;            // IP basina dakikada tarama
const SAAT_HAK = 120;             // IP basina saatte tarama
const ESZAMANLI = 3;              // ayni anda kac tarama (her tarama onlarca RPC cagrisi yapar)
const KUYRUK_SINIRI = 20;
// Fly.io gibi vekiller istegi ~60 sn'de keser. Kendi zaman asimimiz ONDAN ONCE dolmali ki
// kullanici bos bir baglanti hatasi degil, anlasilir bir mesaj gorsun.
const TARAMA_ZAMAN_ASIMI = Number(process.env.HOODCHECK_TIMEOUT_MS || 50_000);
const ONBELLEK_MS = 60_000;

const onbellek = new Map<string, { at: number; rapor: TokenReport }>();
const denetimOnbellek = new Map<string, { at: number; veri: Denetim }>();
const kova = new Map<string, { dk: number[]; sa: number[] }>();
let calisan = 0;
let kuyruk = 0;

function istemciIp(req: http.IncomingMessage): string {
  // Ters vekil arkasindayken gercek IP X-Forwarded-For'da olur. Sadece ILK deger guvenilir
  // sayilir ve yalnizca vekil kullandigimizi bildigimizde (TRUST_PROXY) dikkate alinir.
  if (process.env.TRUST_PROXY === '1') {
    const f = req.headers['x-forwarded-for'];
    const ilk = (Array.isArray(f) ? f[0] : f)?.split(',')[0]?.trim();
    if (ilk) return ilk;
  }
  return req.socket.remoteAddress || 'bilinmiyor';
}

function hakVarMi(ip: string): { ok: boolean; sebep?: string } {
  const t = Date.now();
  const k = kova.get(ip) ?? { dk: [], sa: [] };
  k.dk = k.dk.filter((x) => t - x < 60_000);
  k.sa = k.sa.filter((x) => t - x < 3_600_000);
  if (k.dk.length >= DAKIKA_HAK) return { ok: false, sebep: 'dakika' };
  if (k.sa.length >= SAAT_HAK) return { ok: false, sebep: 'saat' };
  k.dk.push(t); k.sa.push(t);
  kova.set(ip, k);
  if (kova.size > 5000) for (const [key, v] of kova) if (!v.sa.length) kova.delete(key);
  return { ok: true };
}

export async function baslat(): Promise<http.Server> {
  // KESIN ONLEM: bu servis hicbir sekilde bir cuzdan anahtari gormemeli. Kod zaten
  // privateKey vermiyor ama ortamda tanimliysa (yanlislikla, ya da bot ile ayni makinede
  // calisirken) sureci baslatmadan siliyoruz. Boylece "acaba okuyor mu" sorusu kalmiyor.
  for (const k of ['PRIVATE_KEY', 'MNEMONIC', 'SEED_PHRASE']) {
    if (process.env[k]) { log.warn(`${k} ortamda tanimliydi; bu servis anahtar kullanmaz, silindi.`); delete process.env[k]; }
  }

  // ANAHTAR YOK: privateKey bilerek verilmiyor.
  const chain: Chain = await connect({ httpUrl: RPC });
  await chainClock.sync(chain.provider);
  setInterval(() => void chainClock.sync(chain.provider), 30_000);
  log.ok(`HoodCheck zincire baglandi (cuzdansiz, simulasyon ${chain.supportsSimulate ? 'acik' : 'KAPALI'}, RPC ${RPC === GENEL_RPC ? 'genel' : 'ozel'})`);

  // Denetim isini tek yerde topla: iki farkli yerden cagrilmasin, zaman asimi ve onbellek
  // mantigi bolunmesin.
  const denetimYap = async (token: string, anahtar: string): Promise<Denetim> => {
    const veri = await Promise.race([
      tokenDenetimi(chain, token),
      new Promise<Denetim>((f) => setTimeout(() => f({ kaynakHatasi: ['zaman asimi'] }), 20_000)),
    ]);
    denetimOnbellek.set(anahtar, { at: Date.now(), veri });
    if (denetimOnbellek.size > 400)
      for (const [k, v] of denetimOnbellek) if (Date.now() - v.at > 15 * 60_000) denetimOnbellek.delete(k);
    return veri;
  };

  const sunucu = http.createServer(async (req, res) => {
    const gonder = (kod: number, govde: unknown, tip = 'application/json; charset=utf-8') => {
      res.writeHead(kod, {
        'content-type': tip,
        'cache-control': kod === 200 && tip.startsWith('text/html') ? 'public, max-age=300' : 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        // img-src'a 'self' eklendi: maskot sprite'i kendi kaynagimizdan geliyor.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(typeof govde === 'string' ? govde : JSON.stringify(govde));
    };

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') return gonder(405, { error: 'sadece GET' });

      // Iki paylasim adresi: / Turkce, /en Ingilizce. X'in tarayicisi kullanicinin dilini
      // bilemedigi icin kart secimi ADRESE bagli - iki ayri gonderi paylasilir.
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/en' || url.pathname === '/en/') {
        const enMi = url.pathname.startsWith('/en');
        // Sosyal platformlar goreli og:image kabul etmiyor; mutlak adres uretilir.
        // SITE_URL verilmisse o kullanilir (guvenli); yoksa Host basligindan turetilir.
        // GUVENLIK: og:image/og:url mutlak adres ister ve Host basligi ISTEMCININ kontrolunde.
        // Ham Host'u kullanmak, onunde bir CDN varken onbellek zehirlemesine acik kapi birakir
        // (test: "Host: evil.com" -> og:image http://evil.com/og-tr.png). Bu yuzden:
        //   SITE_URL verilmisse yalniz o kullanilir; verilmemisse Host'a SADECE yerel
        //   gelistirmede guvenilir, disaridan gelen baska bir Host kabul edilmez.
        const hamHost = String(req.headers.host ?? '');
        const yerelMi = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hamHost);
        const host = process.env.SITE_URL ? process.env.SITE_URL.replace(/[^A-Za-z0-9.:/-]/g, '')
          : yerelMi ? `http://${hamHost}` : '';
        const baslik = enMi ? 'HoodCheck — Robinhood Chain token risk scanner'
                            : 'HoodCheck — Robinhood Chain token risk taraması';
        const aciklama = enMi
          ? 'Check you can sell it before you buy it. No other service simulates selling on this chain.'
          : 'Almadan önce satabilir misin diye bak. Bu zincirde satış simülasyonu yapan başka bir servis yok.';
        const html = fs.readFileSync(SAYFA, 'utf8')
          .split('{{SITE}}').join(host.replace(/\/$/, ''))
          .split('{{DIL}}').join(enMi ? 'en' : 'tr')
          .split('{{YOL}}').join(enMi ? '/en' : '/')
          .split('{{BASLIK}}').join(baslik)
          .split('{{ACIKLAMA}}').join(aciklama);
        return gonder(200, html, 'text/html; charset=utf-8');
      }
      if (url.pathname === '/saglik') return gonder(200, { ok: true, calisan, kuyruk });

      // Maskot sprite'i: 87 MB'lik GLB'den bir kez uretilmis 24 karelik donme seridi.
      if (/^\/(og-(tr|en)|maskot)\.png$/.test(url.pathname)) {
        const dosya = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel', url.pathname.slice(1));
        if (!fs.existsSync(dosya)) return gonder(404, { error: 'yok' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(fs.readFileSync(dosya));
      }

      // Denetim AYRI uc: holder/dagilim/launchpad bilgisi dis kaynaklardan geliyor ve yavas.
      // Ana raporla ayni cagrida olunca tarama 90 sn'yi asiyordu; sayfa bunu arkadan yukler.
      if (url.pathname === '/api/denetim') {
        const token = (url.searchParams.get('token') ?? '').trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return gonder(400, { error: 'gecerli bir token adresi gerekli' });
        const k = token.toLowerCase();
        const v = denetimOnbellek.get(k);
        if (v && Date.now() - v.at < 5 * 60_000) return gonder(200, v.veri);

        // GUVENLIK: bu uc DIS servislere (robinscan, blockscout) gidiyor. Korumasiz birakilirsa
        // biri bizi doverek o servislerin IP'mizi engellemesine yol acar ve denetim herkes icin
        // olur. Tarama ucuyla ayni hak kovasi ve ayni eszamanlilik siniri uygulanir.
        const dIp = istemciIp(req);
        const dHak = hakVarMi(dIp);
        if (!dHak.ok) return gonder(429, { error: dHak.sebep === 'dakika' ? 'Cok hizli. Bir dakika bekle.' : 'Saatlik hakkin doldu.' });
        if (kuyruk >= KUYRUK_SINIRI) return gonder(503, { error: 'Sistem yogun, biraz sonra dene.' });
        kuyruk++;
        try {
          while (calisan >= ESZAMANLI) await new Promise((f) => setTimeout(f, 200));
          calisan++;
          try {
            return gonder(200, await denetimYap(token, k));
          } finally { calisan--; }
        } finally { kuyruk--; }
      }

      if (url.pathname === '/api/tokencheck') {
        const token = (url.searchParams.get('token') ?? '').trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return gonder(400, { error: 'gecerli bir token adresi gerekli' });

        const anahtar = token.toLowerCase();
        const simdi = Date.now();
        const eski = onbellek.get(anahtar);
        if (eski && simdi - eski.at < ONBELLEK_MS) return gonder(200, eski.rapor);

        const ip = istemciIp(req);
        const hak = hakVarMi(ip);
        if (!hak.ok) {
          res.setHeader?.('retry-after', hak.sebep === 'dakika' ? '60' : '600');
          return gonder(429, { error: hak.sebep === 'dakika' ? 'Cok hizli. Bir dakika bekle.' : 'Saatlik tarama hakkin doldu.' });
        }
        if (kuyruk >= KUYRUK_SINIRI) return gonder(503, { error: 'Sistem yogun, biraz sonra dene.' });

        kuyruk++;
        try {
          while (calisan >= ESZAMANLI) await new Promise((f) => setTimeout(f, 250));
          calisan++;
          try {
            const rapor = await Promise.race([
              tokenReport(chain, token, symbolCount),
              new Promise<never>((_, ret) => setTimeout(() => ret(new Error('tarama zaman asimina ugradi')), TARAMA_ZAMAN_ASIMI)),
            ]);
            onbellek.set(anahtar, { at: Date.now(), rapor });
            if (onbellek.size > 500) for (const [k, v] of onbellek) if (Date.now() - v.at > 5 * ONBELLEK_MS) onbellek.delete(k);
            return gonder(200, rapor);
          } finally { calisan--; }
        } finally { kuyruk--; }
      }

      return gonder(404, { error: 'yok' });
    } catch (e) {
      if (e instanceof TokenDegil) return gonder(404, { error: 'Bu adres bu zincirde bir token gibi gorunmuyor. Adresi kontrol et.' });
      // Ic detaylar (RPC adresi, dosya yollari) disariya sizmasin
      log.error('hoodcheck istek hatasi', e);
      return gonder(500, { error: 'tarama sirasinda bir hata olustu' });
    }
  });

  sunucu.headersTimeout = 15_000;
  sunucu.requestTimeout = 120_000;
  sunucu.listen(PORT, HOST, () => {
    log.ok(`HoodCheck yayinda: http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
      log.warn('DIKKAT: 0.0.0.0 dinleniyor, servis internete acik. Bot paneli (3777) ASLA disari acilmamali.');
      if (!process.env.SITE_URL) log.warn('SITE_URL verilmedi: paylasim karti (og:image) mutlak adres alamaz, X onizlemesi gorunmez. Ornek: SITE_URL=https://alanadi.com');
      if (process.env.TRUST_PROXY !== '1') log.warn('TRUST_PROXY=1 verilmedi: ters vekil arkasindaysan hiz siniri TUM ziyaretcileri tek IP sayar.');
    }
  });
  return sunucu;
}

if (process.argv[1] && process.argv[1].includes('hoodcheck')) {
  baslat().catch((e) => { log.error('HoodCheck baslatilamadi', e); process.exit(1); });
}
