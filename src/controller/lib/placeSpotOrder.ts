import {
  MsgCreateSpotMarketOrder,
  MsgBroadcasterWithPk,
  getEthereumAddress,
  IndexerGrpcSpotApi,
  spotPriceToChainPriceToFixed,
  spotQuantityToChainQuantityToFixed,
  getSpotMarketTensMultiplier,
} from "@injectivelabs/sdk-ts";
import { Network, getNetworkEndpoints } from "@injectivelabs/networks";
import * as fs from "fs";
import * as path from "path";
import { getMarketDetails } from "./injective";
import { getMinimumOrderAmount } from "./utils";

const rootPath = path.resolve(__dirname, "../../");
const filePath = path.join(rootPath, "SpotMarket.json");

// Function to fetch spot market data
async function getSpotMarketData() {
  const NETWORK = Network.Mainnet;
  const ENDPOINTS = getNetworkEndpoints(NETWORK);
  const indexerGrpcSpotApi = new IndexerGrpcSpotApi(ENDPOINTS.indexer);

  try {
    console.log("Fetching market data...");
    const markets = await indexerGrpcSpotApi.fetchMarkets();

    // Convert JSON data to string
    const data = JSON.stringify(markets, null, 2);

    // Write to file asynchronously
    await fs.promises.writeFile(filePath, data);

    console.log("File written successfully.");
    return markets;
  } catch (err) {
    console.error("Error:", err);
    throw err;
  }
}


type MarketDetails = {
  marketId: string;
  baseDecimals: number;
  quoteDecimals: number;
  minPriceTickSize: number;
  minQuantityTickSize: number;
  lowPrice: number;
  highPrice: number;
  price: number;
  bestBidPrice: number | null;
  bestAskPrice: number | null;
  averageBuyPrice: number | null;
  averageSellPrice: number | null;
};

async function placeOrder(
  buyOrSell: number,
  quantity: number,
  ticker: string,
  privateKey: string,
  walletAddress: string
): Promise<{ txHash: string }> {
  const marketDetails: MarketDetails = await getMarketDetails(ticker);
  console.log("Market details:", marketDetails);

  const feeRecipient = "inj1y33jq32shhfgy89mawsg3c7savs257elnf254l";
  const NETWORK = Network.Mainnet;

  try {
    // Create market object with required properties
    const market = {
      marketId: marketDetails.marketId,
      baseDecimals: marketDetails.baseDecimals,
      quoteDecimals: marketDetails.quoteDecimals,
      minPriceTickSize: marketDetails.minPriceTickSize,
      minQuantityTickSize: marketDetails.minQuantityTickSize
    };

    // Calculate appropriate worst price for market orders
    let worstPrice;
    const currentPrice = marketDetails.price;
    // Use smaller buffer for more accurate pricing
    const priceBuffer = 0.02; // 2% buffer

    if (buyOrSell === 1) { // Buy order
      // For buy orders, we need a worst price that's higher than the current ask price
      if (marketDetails.bestAskPrice) {
        // If we have the best ask price, use that with a buffer
        worstPrice = marketDetails.bestAskPrice * (1 + priceBuffer);
      } else if (marketDetails.averageSellPrice) {
        // If we have average sell price from top orders, use that
        worstPrice = marketDetails.averageSellPrice * (1 + priceBuffer);
      } else {
        // Fallback to current price with buffer
        worstPrice = currentPrice * (1 + priceBuffer);
      }
    } else { // Sell order
      // For sell orders, we need a worst price that's lower than the current bid price
      if (marketDetails.bestBidPrice) {
        // If we have the best bid price, use that with a buffer
        worstPrice = marketDetails.bestBidPrice * (1 - priceBuffer);
      } else if (marketDetails.averageBuyPrice) {
        // If we have average buy price from top orders, use that
        worstPrice = marketDetails.averageBuyPrice * (1 - priceBuffer);
      } else {
        // Fallback to current price with buffer
        worstPrice = currentPrice * (1 - priceBuffer);
      }
    }

    // Ensure the price respects the min tick size
    worstPrice = Math.ceil(worstPrice / marketDetails.minPriceTickSize) * marketDetails.minPriceTickSize;

    console.log(`Using worst price for ${buyOrSell === 1 ? 'buy' : 'sell'} order: ${worstPrice}`);
    console.log(`Current market price: ${currentPrice}`);
    if (buyOrSell === 1 && marketDetails.bestAskPrice) {
      console.log(`Best ask price: ${marketDetails.bestAskPrice}`);
    } else if (buyOrSell === 2 && marketDetails.bestBidPrice) {
      console.log(`Best bid price: ${marketDetails.bestBidPrice}`);
    }

    const order = {
      price: worstPrice,
      quantity
    };

    // Create subaccount ID
    const ethereumAddress = getEthereumAddress(walletAddress);
    const subaccountId = ethereumAddress + "0".repeat(23) + "0";

    // Get tens multipliers
    const tensMultipliers = getSpotMarketTensMultiplier({
      minPriceTickSize: marketDetails.minPriceTickSize,
      minQuantityTickSize: marketDetails.minQuantityTickSize,
      baseDecimals: marketDetails.baseDecimals,
      quoteDecimals: marketDetails.quoteDecimals
    });

    const msg = MsgCreateSpotMarketOrder.fromJSON({
      subaccountId,
      injectiveAddress: walletAddress,
      orderType: buyOrSell,
      price: spotPriceToChainPriceToFixed({
        value: order.price,
        tensMultiplier: tensMultipliers.priceTensMultiplier,
        baseDecimals: market.baseDecimals,
        quoteDecimals: market.quoteDecimals,
      }),
      quantity: spotQuantityToChainQuantityToFixed({
        value: order.quantity,
        tensMultiplier: tensMultipliers.quantityTensMultiplier,
        baseDecimals: market.baseDecimals,
      }),
      marketId: market.marketId,
      feeRecipient: feeRecipient,
    });

    console.log("Broadcasting order...");

    const broadcaster = new MsgBroadcasterWithPk({
      privateKey,
      network: NETWORK,
    });

    const txHash = await broadcaster.broadcast({ msgs: msg });
    console.log("Order placed successfully! Transaction Hash:", txHash.txHash);
    return txHash;
  } catch (error) {
    console.error("Error placing order:", error);
    throw error;
  }
}
export { placeOrder, getSpotMarketData };
