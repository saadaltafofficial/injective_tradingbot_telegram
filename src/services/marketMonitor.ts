import { getMarketDetails } from "../controller/lib/injective";
import { getSpotMarketData } from "../controller/lib/placeSpotOrder";
import { UserSettings } from "../config/settings";
import { Bot } from "grammy";
import { type MyContext } from "../controller/lib/Telegram";

interface PriceAlert {
  userId: string;
  ticker: string;
  targetPrice: number;
  condition: "above" | "below";
}

interface SpotMarket {
  marketId: string;
  ticker: string;
  baseDenom: string;
  quoteDenom: string;
  marketStatus: string;
  price: string;
  baseToken: {
    symbol: string;
    decimals: number;
  };
  quoteToken: {
    symbol: string;
    decimals: number;
  };
}

class MarketMonitor {
  private priceAlerts: PriceAlert[] = [];
  private marketUpdateInterval: NodeJS.Timeout | null = null;
  private monitoring: boolean = false;
  private bot?: Bot<MyContext>;

  constructor() {
    // No bot needed anymore
  }

  setBot(bot: Bot<MyContext>) {
    this.bot = bot;
  }

  async addPriceAlert(alert: PriceAlert) {
    this.priceAlerts.push(alert);
    if (!this.monitoring) {
      this.startMonitoring();
    }
  }

  removePriceAlert(userId: string, ticker: string) {
    this.priceAlerts = this.priceAlerts.filter(
      (alert) => !(alert.userId === userId && alert.ticker === ticker)
    );
  }

  startMonitoring() {
    // Start price alert monitoring
    if (!this.monitoring && this.priceAlerts.length > 0) {
      this.monitoring = true;
      this.monitorPriceAlerts();
    }
    
    // Start regular market data updates
    if (!this.marketUpdateInterval) {
      // Update market data every 5 minutes
      this.marketUpdateInterval = setInterval(async () => {
        try {
          // Fetch and update market data
          const marketData = await getSpotMarketData();
          
          // Optional: Log or process market data
          console.log("Market data updated:", marketData.length);
        } catch (error) {
          console.error("Error updating market data:", error);
        }
      }, 5 * 60 * 1000); // 5 minutes
    }
  }

  async monitorPriceAlerts() {
    if (!this.bot) {
      console.warn("Bot not set in market monitor");
      return;
    }

    try {
      const marketData = await getSpotMarketData();

      for (const alert of this.priceAlerts) {
        const [baseSymbol, quoteSymbol] = alert.ticker.split("/");
        const marketInfo = marketData.find(market => 
          market?.baseToken?.symbol === baseSymbol &&
          market?.quoteToken?.symbol === quoteSymbol
        );
        
        if (!marketInfo) continue;

        try {
          // Get current price from market details
          const marketDetails = await getMarketDetails(alert.ticker);
          const currentPrice = marketDetails.price;

          // Check price alert conditions
          const shouldTrigger = 
            (alert.condition === "above" && currentPrice > alert.targetPrice) ||
            (alert.condition === "below" && currentPrice < alert.targetPrice);

          if (shouldTrigger) {
            try {
              // Send alert to user
              await this.bot.api.sendMessage(
                alert.userId, 
                `🚨 Price Alert: ${alert.ticker} is now ${alert.condition} ${alert.targetPrice}. Current price: ${currentPrice.toFixed(4)}`
              );

              // Remove the triggered alert
              this.removePriceAlert(alert.userId, alert.ticker);
            } catch (sendError) {
              console.error(`Error sending price alert to user ${alert.userId}:`, sendError);
            }
          }
        } catch (marketError) {
          console.error(`Error fetching market details for ${alert.ticker}:`, marketError);
          continue;
        }
      }
    } catch (error) {
      console.error("Error monitoring price alerts:", error);
    }

    // Continue monitoring if there are remaining alerts
    if (this.priceAlerts.length > 0) {
      setTimeout(() => this.monitorPriceAlerts(), 30000); // Check every 30 seconds
    } else {
      this.monitoring = false;
    }
  }

  stopMonitoring() {
    if (this.marketUpdateInterval) {
      clearInterval(this.marketUpdateInterval);
      this.marketUpdateInterval = null;
    }
    this.monitoring = false;
  }

  cleanup() {
    this.stopMonitoring();
  }
}

export { MarketMonitor, PriceAlert };
