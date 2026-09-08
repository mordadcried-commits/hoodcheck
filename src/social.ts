// Token'in zincir uzerindeki "hikaye" verisi: aciklama, sosyal link, logo.
// PONS/pair.fund tokenleri bu alanlari kontratta tutuyor (description(), socials(), logo()).
// Kullanicinin elle yaptigi eleme buydu: once temaya/hikayeye bak, sonra Twitter'a bak.
// Olcum (64 lansman pozisyonu): hikayesi VE sosyali olmayanlar ort x0.956 (net -0.0036 ETH),
// aciklamasi >=60 karakter olanlar ort x1.208 (net +0.0050 ETH).
import { ethers } from 'ethers';
import type { Chain } from './rpc.js';
import { log } from './logger.js';

export interface TokenSocial {
  description: string;
  socials: string;
  logo: string;
  hasTwitter: boolean;
  descLen: number;
}

const cache = new Map<string, TokenSocial>();
const SEL = {
  description: ethers.id('description()').slice(0, 10),
  socials: ethers.id('socials()').slice(0, 10),
  logo: ethers.id('logo()').slice(0, 10),
  tokenURI: ethers.id('tokenURI()').slice(0, 10),
};

// Donus: { value, failed } - HATA ile BOS ayirt edilmeli.
// Hiz limitine takilan okuma bos sayilip onbellege girince token kalici olarak "hikayesiz"
// oluyordu ve saglam tokenler eleniyordu (07.09: 49 adayin 48'i yanlislikla elendi).
async function readString(chain: Chain, token: string, selector: string): Promise<{ value: string; failed: boolean }> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await chain.provider.call({ to: token, data: selector });
      if (!r || r === '0x') return { value: '', failed: false };
      return { value: String(ethers.AbiCoder.defaultAbiCoder().decode(['string'], r)[0] ?? '').trim(), failed: false };
    } catch (e) {
      const msg = (e as Error).message ?? '';
      // Fonksiyon yoksa revert gelir: bu gercek "yok" cevabidir, tekrar denemeye gerek yok
      if (/revert|execution reverted|call_exception|CALL_EXCEPTION/i.test(msg) && !/429|rate|limit|timeout/i.test(msg)) return { value: '', failed: false };
      if (i === 0) { await new Promise((r) => setTimeout(r, 600)); continue; }
      return { value: '', failed: true };
    }
  }
  return { value: '', failed: true };
}

// pair.fund tipi tokenler hikayeyi kontratta degil, tokenURI()'deki JSON'da tutuyor.
// Bu okunmadigi icin twitter'i olan tokenler yanlislikla eleniyordu (07.09 PRODUCT, AMD).
async function fromTokenUri(chain: Chain, token: string): Promise<{ description: string; socials: string; logo: string } | null> {
  const uriR = await readString(chain, token, SEL.tokenURI);
  const uri = uriR.value;
  if (!uri) return null;
  const url = uri.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + uri.slice(7) : uri;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    const pick = (...keys: string[]) => { for (const key of keys) { const v = j[key]; if (typeof v === 'string' && v.trim()) return v.trim(); } return ''; };
    const links = [pick('twitter', 'twitter_url', 'x'), pick('website', 'external_url'), pick('telegram')].filter(Boolean).join(' ');
    return { description: pick('description', 'desc'), socials: links, logo: pick('image', 'image_url', 'logo') };
  } catch { return null; }
}

export async function tokenSocial(chain: Chain, token: string): Promise<TokenSocial> {
  const k = token.toLowerCase();
  const hit = cache.get(k);
  if (hit) return hit;
  const [rd, rs, rl] = await Promise.all([
    readString(chain, token, SEL.description),
    readString(chain, token, SEL.socials),
    readString(chain, token, SEL.logo),
  ]);
  let description = rd.value, socials = rs.value, logo = rl.value;
  const readFailed = rd.failed || rs.failed;
  if (!description && !socials) {
    const meta = await fromTokenUri(chain, token);
    if (meta) { description = meta.description; socials = meta.socials; logo = logo || meta.logo; }
  }
  const v: TokenSocial = {
    description, socials, logo,
    hasTwitter: /x\.com|twitter\.com/i.test(socials),
    descLen: description.length,
  };
  // Okuma hata verdiyse ONBELLEGE ALMA: bir sonraki denemede tekrar bakilsin
  if (!readFailed) { cache.set(k, v); if (cache.size > 20_000) cache.clear(); }
  log.debug(`${token.slice(0, 10)} sosyal: aciklama ${v.descLen} krk, twitter ${v.hasTwitter ? 'var' : 'yok'}`);
  return v;
}
