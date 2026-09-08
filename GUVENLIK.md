# HoodCheck — canliya cikis guvenlik kontrol listesi

Son denetim: 08.09.2026. Asagidakiler test edilerek dogrulandi, tahmin degil.

## Test edilenler ve sonuclari

| Test | Sonuc |
|---|---|
| Dizin gecisi (10 varyant: `../`, URL-encoded, null bayt) | Hepsi 404 |
| Bot uclari sizmis mi (`/api/state`, `/api/setup`, `/api/control`, `/api/positions/*`) | Hepsi 404 |
| GET disi metotlar (POST/PUT/DELETE/PATCH/OPTIONS) | 405 |
| Girdi dogrulama (11 kotu girdi: SQL, XSS, yol, URL) | Hepsi 400 |
| **XSS — zincirden gelen token adi/sembolu** | Yuk calismadi, DOM'a img/script girmedi |
| Guvenlik basliklari (CSP, nosniff, X-Frame-Options, Referrer-Policy) | Tamam |
| Sunucu parmak izi (`Server`, `X-Powered-By`) | Gonderilmiyor |
| Hata mesajlarinda ic detay (yol, RPC adresi, yigin izi) | Yok |
| RPC adresi / Alchemy anahtari yanitlarda | Hicbir uctan sizmiyor |
| Hiz siniri (`/api/tokencheck`) | 14 istekte 4x 429 |

## Denetimde bulunan ve KAPATILAN iki acik

**1. `/api/denetim` korumasizdi.** 30 hizli istegin 30'u da geciyordu. Bu uc dis servislere
(robinscan, blockscout) gidiyor; biri bunu doverse o servisler bizim IP'mizi engeller ve
denetim ozelligi herkes icin oludur. Tarama ucuyla ayni hak kovasi ve eszamanlilik
sinirina alindi. Dogrulama: 16 istekte 6x 429.

**2. Host basligi og:image'i zehirliyordu.** `Host: evil.com` gonderince kart adresi
`http://evil.com/og-tr.png` oluyordu. Onunde bir CDN varken bu onbellek zehirlemesine
donusur. Artik: SITE_URL verilmisse yalniz o kullanilir; verilmemisse Host'a SADECE yerel
gelistirmede guvenilir, disaridan gelen Host reddedilir (goreli yola dusulur).
Dogrulama: `Host: evil.com` -> `/og-tr.png`, `SITE_URL=https://x` -> `https://x/og-tr.png`.

## Canliya cikarken UYULMASI GEREKENLER

1. **Bot paneli (3777) ASLA disari acilmaz.** Icinde private key girisi, canli mod anahtari
   ve alim-satim uclari var. 127.0.0.1'de kalir. Sunucuda calistirilacaksa guvenlik
   duvarindan kapatilmali.
2. **`.env` sunucuya YUKLENMEZ.** Icinde Alchemy anahtari var. Sunucuda ortam degiskeni
   olarak verilir. `.gitignore` zaten koruyor ama elle kopyalarken dikkat.
3. **`data/` klasoru YUKLENMEZ.** Icinde islem gecmisi ve pozisyonlar var; siteyle ilgisi yok.
4. **`SITE_URL` verilir** (`SITE_URL=https://alanadi.com`), yoksa paylasim karti gorunmez.
5. **`TRUST_PROXY=1`** verilir - ters vekil/CDN arkasindaysan, yoksa hiz siniri tum
   ziyaretcileri tek IP sanip herkesi engeller.
6. **HTTPS zorunlu.** Vercel/Netlify/Cloudflare otomatik veriyor.
7. Servis **root olmayan** bir kullaniciyla calistirilir.

## Bilinerek kabul edilen sinirlar

- CSP'de `script-src 'unsafe-inline'` var: sayfa tek dosya ve tum betik satir ici. Disaridan
  betik yuklenmedigi ve kullanici girdisi HTML'e escape edilerek girdigi icin kabul edildi.
  Ileride harici dosyaya tasinirsa nonce'a gecilmeli.
- Tek bir tarama 8-22 sn surer ve eszamanli 3 ile sinirlidir. Cok sayida IP'den gelen
  dagitik bir yuk servisi yavaslatabilir; ucretsiz bir arac icin kabul edilebilir.
  Onunde Cloudflare olursa bu da buyuk olcude kapanir.
