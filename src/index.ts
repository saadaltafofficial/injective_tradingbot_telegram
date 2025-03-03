import dotenv from "dotenv";
import mongoose from "mongoose";
import { bot } from "./controller/lib/Telegram";
import { MarketMonitor } from "./services/marketMonitor";

dotenv.config();

mongoose.set('strictQuery', false);

let isShuttingDown = false;
let marketMonitor: MarketMonitor;

async function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log("Shutting down gracefully...");
  try {
    // Delete any existing webhook
    await bot.api.deleteWebhook();
    
    // Stop the bot
    await bot.stop();
    console.log("Bot stopped successfully");
  } catch (error) {
    console.error("Error stopping bot:", error);
  }
  
  // Exit the process
  process.exit(0);
}

// Handle cleanup on various signals
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGUSR2", cleanup); // For nodemon restart
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  cleanup();
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  cleanup();
});

async function startBot() {
  try {
    console.log("Starting bot...");
    console.log("Connecting to MongoDB...");
    const mongoURI = process.env.MONGODB_URI || "";
    
    try {
      // Add a timeout to the MongoDB connection to fail faster
      console.log("Attempting MongoDB connection with timeout...");
      await mongoose.connect(mongoURI, {
        serverSelectionTimeoutMS: 5000, // 5 seconds timeout
        connectTimeoutMS: 5000
      });
      console.log("Connected to MongoDB");
    } catch (mongoError: any) {
      console.warn("MongoDB connection failed, continuing without database functionality:", mongoError.message);
      console.warn("User and wallet data will not be saved. This is fine for development and testing.");
    }

    // Initialize and update SpotMarket.json in the background
    console.log("Updating market data in the background...");
    (async () => {
      try {
        console.log("Importing getSpotMarketData...");
        const { getSpotMarketData } = await import('./controller/lib/placeSpotOrder');
        console.log("Running getSpotMarketData...");
        await getSpotMarketData();
        console.log("SpotMarket.json updated successfully");
      } catch (error) {
        console.error("Error updating market data:", error);
      }
    })();

    // Initialize market monitor
    console.log("Initializing market monitor...");
    marketMonitor = new MarketMonitor();
    marketMonitor.setBot(bot);
    marketMonitor.startMonitoring();
    console.log("Market monitor started.");

    // Start the bot
    console.log("Starting the bot...");
    await bot.start({
      onStart(botInfo: any) {
        console.log(`Bot @${botInfo.username} is running...`);
      },
    });
    console.log("Bot started successfully.");

    // Listen for specific events
    console.log("Setting up event listeners...");
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    console.log("Bot initialization complete.");
  } catch (error) {
    console.error("Error starting bot:", error);
    process.exit(1);
  }
}

startBot();

// Export marketMonitor for use in other files
export { marketMonitor };