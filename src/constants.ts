// Robinhood Chain (Arbitrum Orbit L2) sabitleri.
// Adresler resmi kaynaklardan dogrulandi (Uniswap deployments/4663.md, docs.bags.fm/robinhood, docs.robinhood.com/chain)
// ve canli zincirde eth_getCode ile kontrol edildi.
import { ethers } from 'ethers';

export const CHAIN_ID = 4663;
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

export const ADDR = {
  ZERO: '0x0000000000000000000000000000000000000000',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',

  UNI_V2_FACTORY: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  UNI_V2_ROUTER: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',

  UNI_V3_FACTORY: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  UNI_V3_QUOTER_V2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  UNI_V3_SWAP_ROUTER_02: '0xcaf681a66d020601342297493863e78c959e5cb2',

  UNI_V4_POOL_MANAGER: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  UNI_V4_QUOTER: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  UNI_V4_STATE_VIEW: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  UNIVERSAL_ROUTER: '0x8876789976decbfcbbbe364623c63652db8c0904',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',

  // hood.fun (Bags) launchpad
  BAGS_FACTORY: '0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37',
  BAGS_LENS: '0xC82Db941dAf90B754aecb5F7D14c683dc608d595',
  BAGS_V4_HOOK: '0x2380aBf72C17aABAb76480244759AC7E2932EEcC',
} as const;

// Uniswap v4 dinamik ucret bayragi (fee alaninda 0x800000)
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;
export const BAGS_DEPLOY_BLOCK = 7_887_312;

export const TOPICS = {
  TRANSFER: ethers.id('Transfer(address,address,uint256)'),
  WETH_DEPOSIT: ethers.id('Deposit(address,uint256)'),
  WETH_WITHDRAWAL: ethers.id('Withdrawal(address,uint256)'),
  V2_SWAP: ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  V2_MINT: ethers.id('Mint(address,uint256,uint256)'),
  V2_BURN: ethers.id('Burn(address,uint256,uint256,address)'),
  V2_PAIR_CREATED: ethers.id('PairCreated(address,address,address,uint256)'),
  V3_SWAP: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  V3_MINT: ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)'),
  V3_BURN: ethers.id('Burn(address,int24,int24,uint128,uint256,uint256)'),
  V3_POOL_CREATED: ethers.id('PoolCreated(address,address,uint24,int24,address)'),
  V4_SWAP: ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  V4_INITIALIZE: ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
  V4_MODIFY_LIQUIDITY: ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'),
  BAGS_TOKENS_BOUGHT: ethers.id('TokensBought(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)'),
  BAGS_TOKENS_SOLD: ethers.id('TokensSold(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)'),
  BAGS_MIGRATED: ethers.id('Migrated(address,address,address,uint256,uint256,bytes32,uint160)'),
  BAGS_TOKEN_CREATED: ethers.id('TokenCreated(address,address,address,address,address,bytes32,string,string,string)'),
} as const;

export const lc = (a: string) => a.toLowerCase();
export const short = (a: string) => a.slice(0, 6) + '..' + a.slice(-4);
export const txLink = (h: string) => `${EXPLORER}/tx/${h}`;
export const tokenLink = (a: string) => `${EXPLORER}/token/${a}`;

// PONS launchpad (pons.fun): fabrika + egri olaylari. Egri ABI dogrulanmamis; seciciler ve olaylar zincirden cikarildi (Eylul 2026).
export const PONS = { FACTORY: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' } as const;
export const PONS_TOPICS = {
  CREATE: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607', // fabrika: (token idx, curve idx, creator idx, ...)
  BUY: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',    // egri: (buyer idx, recipient idx) data: quoteIn, tokensOut, fee, creatorFee
  SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',   // egri: (seller idx, recipient idx) data: tokensIn, quoteOut, fee, creatorFee
} as const;
