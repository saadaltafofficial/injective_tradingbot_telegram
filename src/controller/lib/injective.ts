import {
  ChainGrpcBankApi,
  IndexerGrpcSpotApi,
  IndexerRestSpotChronosApi,
} from "@injectivelabs/sdk-ts";
import { getNetworkEndpoints, Network } from "@injectivelabs/networks";
import { TokenFactory, tokenMetaUtils } from "@injectivelabs/token-metadata";
import { getInjectiveAddress } from "@injectivelabs/sdk-ts";
import { Wallet } from "ethers";
import spotMarkets from "../../../src/SpotMarket.json";

const endpoints = getNetworkEndpoints(Network.Mainnet);
const indexerRestSpotChronosApi = new IndexerRestSpotChronosApi(
  `${endpoints.chronos}/api/chronos/v1/spot`
);
const indexerGrpcSpotApi = new IndexerGrpcSpotApi(endpoints.indexer);

async function createInjectiveWallet() {
  const wallet = Wallet.createRandom();
  const ethereumAddress = wallet.address;
  const privateKey = wallet.privateKey;
  const mnemonic = wallet.mnemonic?.phrase;

  const injectiveAddress = getInjectiveAddress(ethereumAddress);

  console.log("Private Key:", privateKey);
  console.log("Injective address from Ethereum address => ", injectiveAddress);
  console.log("Ethereum address from Injective address => ", ethereumAddress);

  return { privateKey, ethereumAddress, injectiveAddress };
}

async function getInjectiveBalance(address: string) {
  try {
    const chainGrpcBankApi = new ChainGrpcBankApi(endpoints.grpc);
    const balances = await chainGrpcBankApi.fetchBalances(address);
    console.log(balances);

    if (balances.balances.length > 0) {
      let balance = balances.balances;
      let message = "";

      for (let i = 0; i < balance.length; i++) {
        let tokenMetadata = await fetchDenomMetadata(balance[i].denom);
        let tokenDecimals = tokenMetadata?.decimals;
        let amount = parseInt(balance[i].amount) / 10 ** tokenDecimals!;
        message += `Token: ${tokenMetadata?.symbol}, Amount: ${amount.toFixed(
          4
        )}\n`;
      }
      console.log(message);

      return message;
    } else {
      return `(0.0) Please deposit some INJ to your wallet`;
    }
  } catch (error) {
    console.error("Failed to fetch balance:", error);
    return 0;
  }
}

function validateDenomFormat(denom: string): boolean {
  const peggyRegex = /^peggy0x[a-fA-F0-9]{40}$/;
  const ibcRegex = /^ibc\/[A-F0-9]{64}$/;
  const factoryRegex = /^factory\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+$/;

  if (denom === "inj") {
    return true; // Native denom
  } else if (peggyRegex.test(denom)) {
    return true; // Valid Peggy denom
  } else if (ibcRegex.test(denom)) {
    return true; // Valid IBC denom
  } else if (factoryRegex.test(denom)) {
    return true; // Valid Factory denom
  } else {
    return false; // Invalid denom format
  }
}

async function fetchDenomMetadata(denom: string) {
  const tokenfactory = new TokenFactory(tokenMetaUtils);
  try {
    const tokenMeta = tokenfactory.toToken(denom);
    if (tokenMeta) {
      return tokenMeta;
    }
  } catch (error) {
    console.error("Error fetching denom metadata:", error);
    return null;
  }
}

async function isValidDenom(denom: string): Promise<boolean> {
  if (!validateDenomFormat(denom)) {
    console.error("Invalid denom format");
    return false;
  }

  const metadata = await fetchDenomMetadata(denom);
  if (!metadata) {
    console.error("Denom does not exist on the Injective chain");
    return false;
  }

  return true;
}

export type MarketDetails = {
  marketId: string;
  baseDecimals: number;
  quoteDecimals: number;
  minPriceTickSize: number;
  minQuantityTickSize: number;
  baseSymbol: string;
  quoteSymbol: string;
  highPrice: number;
  lowPrice: number;
  price: number;
  open: number;
  bestBidPrice: number | null;
  bestAskPrice: number | null;
  averageBuyPrice: number | null;
  averageSellPrice: number | null;
  baseDenom: string;
};

// Function to fetch a market by its ticker
const getMarketDetails = async (ticker: string): Promise<MarketDetails> => {
  if (!ticker) {
    throw new Error("Ticker is required");
  }

  const tickerMarket = spotMarkets.find(
    (market: any) => market.ticker === ticker
  );

  if (!tickerMarket) {
    throw new Error(`Market not found for ticker: ${ticker}`);
  }

  if (!tickerMarket.marketId) {
    throw new Error(`Market ID not found for ticker: ${ticker}`);
  }

  try {
    const marketSummary = await indexerRestSpotChronosApi.fetchMarketSummary(
      tickerMarket.marketId
    );
    const orderBook = await indexerGrpcSpotApi.fetchOrderbookV2(
      tickerMarket.marketId
    );

    if (!tickerMarket.baseToken || !tickerMarket.quoteToken) {
      throw new Error(`Missing token details for market: ${ticker}`);
    }

    let totalBuyVolume = 0;
    let totalSellVolume = 0;
    let weightedBuyPrice = 0;
    let weightedSellPrice = 0;

    // Get best bid and ask prices
    const bestBidPrice = orderBook.buys.length > 0 ? parseFloat(orderBook.buys[0].price) : null;
    const bestAskPrice = orderBook.sells.length > 0 ? parseFloat(orderBook.sells[0].price) : null;

    // Limit the depth of the orderbook we consider for average price calculation
    // This prevents outlier orders from skewing the average too much
    const maxOrdersToConsider = 5; // Consider only top 5 orders on each side

    const topBuys = orderBook.buys.slice(0, maxOrdersToConsider);
    const topSells = orderBook.sells.slice(0, maxOrdersToConsider);

    topBuys.forEach((item) => {
      const price = parseFloat(item.price);
      const quantity = parseFloat(item.quantity);
      totalBuyVolume += quantity;
      weightedBuyPrice += price * quantity;
    });

    topSells.forEach((item) => {
      const price = parseFloat(item.price);
      const quantity = parseFloat(item.quantity);
      totalSellVolume += quantity;
      weightedSellPrice += price * quantity;
    });

    const averageBuyPrice =
      totalBuyVolume > 0
        ? (weightedBuyPrice / totalBuyVolume).toFixed(4)
        : null;
    const averageSellPrice =
      totalSellVolume > 0
        ? (weightedSellPrice / totalSellVolume).toFixed(4)
        : null;

    return {
      marketId: tickerMarket.marketId,
      baseDecimals: tickerMarket.baseToken.decimals,
      quoteDecimals: tickerMarket.quoteToken.decimals,
      minPriceTickSize: tickerMarket.minPriceTickSize,
      minQuantityTickSize: tickerMarket.minQuantityTickSize,
      baseSymbol: tickerMarket.baseToken.symbol,
      quoteSymbol: tickerMarket.quoteToken.symbol,
      highPrice: marketSummary.high,
      lowPrice: marketSummary.low,
      price: marketSummary.price,
      open: marketSummary.open,
      bestBidPrice,
      bestAskPrice,
      averageBuyPrice: averageBuyPrice ? parseFloat(averageBuyPrice) : null,
      averageSellPrice: averageSellPrice ? parseFloat(averageSellPrice) : null,
      baseDenom: tickerMarket.baseDenom,
    };
  } catch (error) {
    console.error("Error fetching market details:", error);
    throw error;
  }
};

async function getMultiWalletBalances(addresses: string[]) {
  try {
    const chainGrpcBankApi = new ChainGrpcBankApi(endpoints.grpc);
    const allBalances: { [key: string]: { [token: string]: number } } = {};

    for (const address of addresses) {
      const balances = await chainGrpcBankApi.fetchBalances(address);

      if (balances.balances.length > 0) {
        allBalances[address] = {};

        for (const balance of balances.balances) {
          let tokenMetadata = await fetchDenomMetadata(balance.denom);
          let tokenDecimals = tokenMetadata?.decimals;
          let amount = parseInt(balance.amount) / 10 ** tokenDecimals!;

          if (amount > 0) {
            allBalances[address][tokenMetadata?.symbol || balance.denom] =
              amount;
          }
        }
      }
    }

    return allBalances;
  } catch (error) {
    console.error("Failed to fetch multi-wallet balances:", error);
    return {};
  }
}

export {
  createInjectiveWallet,
  getInjectiveBalance,
  isValidDenom,
  getMarketDetails,
  getMultiWalletBalances,
  getInjectiveAddress,
};
