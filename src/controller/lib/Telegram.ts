// Core imports
import { Bot, Context, InlineKeyboard, session, SessionFlavor, Composer } from "grammy";
import {
  conversations,
  createConversation,
  Conversation,
  ConversationFlavor,
} from "@grammyjs/conversations";

// Custom session data interface
interface SessionData {
  conversationState?: unknown;
  walletIndex?: number;
  orderType?: "buy" | "sell";
  ticker?: string;
}

// Modify the context type to ensure conversation is always present
type MyContext = Context & {
  conversation:
    | {
        enter: (
          name: string,
          options?: {
            walletIndex?: number;
            orderType?: "buy" | "sell";
            ticker?: string;
          }
        ) => Promise<void>;
        exit: () => Promise<void>;
      }
    | undefined;
} & ConversationFlavor &
  SessionFlavor<SessionData>;

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { User } from "../../db/models";
import {
  connectToDatabase,
  getOrCreateUser,
  isDatabaseConnected,
} from "../../db/index";
import { UserSettings } from "../../config/settings";
import {
  createInjectiveWallet,
  getInjectiveBalance,
  getMarketDetails,
  getMultiWalletBalances,
  getInjectiveAddress,
} from "./injective";
import dotenv from "dotenv";
import { placeOrder, getSpotMarketData } from "./placeSpotOrder";
import { decryptPrivateKey, encryptPrivateKey } from "./utils";
import { SecurityUtils } from "../../utils/security";
import { ethers } from "ethers";

dotenv.config();

// Create bot instance with proper typing
const token = process.env.MY_TOKEN;
if (!token) {
  throw new Error("MY_TOKEN environment variable is not set");
}
const bot = new Bot<MyContext>(token);

// Use session middleware
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// Database connection check
function isDbConnected() {
  return isDatabaseConnected();
}

// Initialize bot
async function initBot() {
  try {
    // Connect to database
    const dbConnected = await connectToDatabase();
    console.log(
      `Database connection status: ${
        dbConnected ? "Connected" : "Failed to connect"
      }`
    );

    // Setup bot conversations
    setupBotConversations(bot);

    // Start the bot
    await bot.start();
    console.log("Bot started successfully");
  } catch (error) {
    console.error("Error starting bot:", error);
  }
}

// Handle /start command
bot.command("start", async (ctx) => {
  try {
    // Get user information
    const userId = ctx.from?.id.toString();
    const username = ctx.from?.username || "unknown";
    const firstName = ctx.from?.first_name;
    const lastName = ctx.from?.last_name;

    if (!userId) {
      await ctx.reply("Could not identify user. Please try again.");
      return;
    }

    // Create or get user from database
    if (isDbConnected()) {
      const user = await getOrCreateUser(userId, username, firstName, lastName);
      if (user) {
        console.log(`User ${username} (${userId}) started the bot`);
      } else {
        console.error(`Failed to create/get user ${username} (${userId})`);
      }
    } else {
      console.warn("Database not connected. User data will not be saved.");
    }

    // Send welcome message with main menu
    await ctx.reply(
      `🚀 Welcome to the Injective Trading Bot, ${
        firstName || username
      }! \n\n` +
        `This bot allows you to trade on the Injective Chain directly from Telegram.\n\n` +
        `Select an option from the menu below:`,
      { reply_markup: mainMenuKeyboard }
    );
  } catch (error) {
    console.error("Error in start command:", error);
    await ctx.reply(
      "⚠️ An error occurred while starting the bot. Please try again."
    );
  }
});

// Define conversations
async function handlePortfolioConversion(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  try {
    if (!ctx.from) {
      await ctx.reply("User not found");
      return;
    }

    // Check if database is connected
    if (!isDbConnected()) {
      await ctx.reply(
        "Database functionality is currently unavailable. The portfolio feature requires a database connection.",
        {
          reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
        }
      );
      return;
    }

    // Find user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from.id.toString(),
    });

    if (!userSettings || userSettings.wallets.length === 0) {
      await ctx.reply(
        "You don't have any wallets yet. Create a wallet first!",
        {
          reply_markup: new InlineKeyboard()
            .text("Create Wallet", "create_wallet")
            .text("Back", "main_menu"),
        }
      );
      return;
    }

    // Get wallet addresses
    const walletAddresses = userSettings.wallets.map(
      (wallet) => wallet.address
    );

    // Fetch balances for all wallets
    const multiWalletBalances = await getMultiWalletBalances(walletAddresses);

    // Prepare portfolio message
    let portfolioMessage = "📊 Your Portfolio:\n\n";

    // Aggregate tokens across all wallets
    const aggregatedTokens: { [token: string]: number } = {};

    // Type guard and safe iteration
    if (multiWalletBalances && typeof multiWalletBalances === "object") {
      for (const [address, balances] of Object.entries(multiWalletBalances)) {
        if (typeof balances === "object" && balances !== null) {
          const walletName =
            userSettings.wallets.find((w) => w.address === address)?.name ||
            "Unnamed Wallet";
          portfolioMessage += ` ${walletName} (${address.substring(
            0,
            8
          )}...):\n`;

          for (const [token, amount] of Object.entries(balances)) {
            if (typeof amount === "number") {
              portfolioMessage += `   • ${token}: ${amount.toFixed(4)}\n`;

              // Aggregate tokens
              aggregatedTokens[token] = (aggregatedTokens[token] || 0) + amount;
            }
          }

          portfolioMessage += "\n";
        }
      }

      // Add total portfolio summary
      portfolioMessage += "💰 Total Portfolio:\n";
      for (const [token, amount] of Object.entries(aggregatedTokens)) {
        portfolioMessage += `   • ${token}: ${amount.toFixed(4)}\n`;
      }

      const keyboard = new InlineKeyboard()
        .text(" Refresh", "portfolio")
        .text(" Back", "main_menu");

      await ctx.reply(portfolioMessage, {
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply("⚠️ Unable to fetch wallet balances. Please try again.", {
        reply_markup: new InlineKeyboard()
          .text(" Retry", "portfolio")
          .text(" Back", "main_menu"),
      });
    }
  } catch (error) {
    console.error("Portfolio conversation error:", error);
    await ctx.reply("⚠️ Error fetching portfolio. Please try again.", {
      reply_markup: new InlineKeyboard()
        .text(" Retry", "portfolio")
        .text(" Back", "main_menu"),
    });
  }
}

// Trade conversation handler
async function handleTradeConversation(
  conversation: Conversation<MyContext>,
  ctx: MyContext,
  orderType: "buy" | "sell",
  ticker?: string
) {
  try {
    // Check if database is connected
    if (!isDbConnected()) {
      await ctx.reply(
        "Database functionality is currently unavailable. Trading requires a database connection to access your wallet.",
        {
          reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
        }
      );
      return;
    }

    // Validate user has settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    if (
      !userSettings ||
      !userSettings.wallets ||
      userSettings.wallets.length === 0
    ) {
      await ctx.reply(
        "You need to set up a wallet before trading. Would you like to create one now?",
        {
          reply_markup: new InlineKeyboard()
            .text("Create Wallet", "create_wallet")
            .text(" Back", "main_menu"),
        }
      );
      return;
    }

    // If ticker is not provided, ask user to select a market
    if (!ticker) {
      await ctx.reply(
        `🔍 Please enter the ticker symbol you want to ${orderType} (e.g., INJ/USDT):`
      );
      const tickerResponse = await conversation.wait();
      ticker = tickerResponse.message?.text?.toUpperCase();

      if (!ticker) {
        await ctx.reply("⚠️ Invalid ticker. Trading cancelled.");
        return;
      }
    }

    // Get market details to validate ticker and show current price
    try {
      const marketDetails = await getMarketDetails(ticker);
      if (!marketDetails) {
        await ctx.reply(
          `⚠️ Market ${ticker} not found. Please try again with a valid ticker.`,
          {
            reply_markup: new InlineKeyboard()
              .text("Search Markets", "search_markets")
              .text(" Back", "main_menu"),
          }
        );
        return;
      }

      // Show market info
      const currentPrice = marketDetails.price;
      const priceChange = (
        ((marketDetails.price - marketDetails.open) / marketDetails.open) *
        100
      ).toFixed(2);
      const direction = priceChange.startsWith("-") ? "📉" : "📈";

      await ctx.reply(
        `${direction} ${ticker} - Current Price: ${currentPrice} ${marketDetails.quoteSymbol}\n` +
          `24h Change: ${priceChange}%\n` +
          `High: ${marketDetails.highPrice} | Low: ${marketDetails.lowPrice}\n\n` +
          `You are about to ${orderType.toUpperCase()} ${ticker}. Please select a wallet to use:`
      );

      // Let user select a wallet
      const walletKeyboard = new InlineKeyboard();
      userSettings.wallets.forEach((wallet, index) => {
        walletKeyboard.text(
          `${wallet.name} (${wallet.address.substring(0, 8)}...)`,
          `select_wallet_${index}_${orderType}_${ticker}`
        );
        walletKeyboard.row();
      });
      walletKeyboard.text(" Cancel", "main_menu");

      await ctx.reply("Select a wallet:", { reply_markup: walletKeyboard });
      return;
    } catch (error) {
      console.error("Error fetching market details:", error);
      await ctx.reply(
        "⚠️ Error fetching market details. Please try again later.",
        {
          reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
        }
      );
      return;
    }
  } catch (error) {
    console.error("Trade conversation error:", error);
    await ctx.reply(
      "⚠️ An error occurred during the trading process. Please try again later.",
      {
        reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
      }
    );
  }
}

// Wallet selection handler for trading
async function handleWalletSelection(
  conversation: Conversation<MyContext>,
  ctx: MyContext,
  walletIndex: number,
  orderType: "buy" | "sell",
  ticker: string
) {
  try {
    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    if (
      !userSettings ||
      !userSettings.wallets ||
      userSettings.wallets.length <= walletIndex
    ) {
      await ctx.reply("Wallet not found. Please try again.");
      return;
    }

    const selectedWallet = userSettings.wallets[walletIndex];

    // Get wallet balance
    const balances = await getInjectiveBalance(selectedWallet.address);
    await ctx.reply(
      `Selected wallet: ${
        selectedWallet.name
      }\nAddress: ${selectedWallet.address.substring(
        0,
        8
      )}...${selectedWallet.address.substring(
        selectedWallet.address.length - 4
      )}\n\nWallet Balance:\n${balances}`
    );

    // Ask for quantity
    await ctx.reply(
      `How much ${ticker.split("/")[0]} do you want to ${orderType}?`
    );
    const quantityResponse = await conversation.wait();
    const quantity = parseFloat(quantityResponse.message?.text || "0");

    if (isNaN(quantity) || quantity <= 0) {
      await ctx.reply("⚠️ Invalid quantity. Trading cancelled.");
      return;
    }

    // Get market details for price
    const marketDetails = await getMarketDetails(ticker);
    const estimatedTotal = quantity * marketDetails.price;

    // Confirm order
    await ctx.reply(
      `📝 Order Summary:\n` +
        `${orderType.toUpperCase()} ${quantity} ${ticker.split("/")[0]}\n` +
        `Price: ~${marketDetails.price} ${marketDetails.quoteSymbol}\n` +
        `Total: ~${estimatedTotal.toFixed(6)} ${
          marketDetails.quoteSymbol
        }\n\n` +
        `Do you want to proceed?`,
      {
        reply_markup: new InlineKeyboard()
          .text(
            "✅ Confirm",
            `confirm_${orderType}_${quantity}_${ticker}_${walletIndex}`
          )
          .text("❌ Cancel", "main_menu"),
      }
    );
  } catch (error) {
    console.error("Wallet selection error:", error);
    await ctx.reply(
      "⚠️ An error occurred while processing your wallet selection. Please try again later.",
      {
        reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
      }
    );
  }
}

// Order confirmation handler
async function handleOrderConfirmation(
  ctx: MyContext,
  orderType: "buy" | "sell",
  quantity: number,
  ticker: string,
  walletIndex: number
) {
  try {
    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    if (
      !userSettings ||
      !userSettings.wallets ||
      userSettings.wallets.length <= walletIndex
    ) {
      await ctx.reply("Wallet not found. Please try again.");
      return;
    }

    const selectedWallet = userSettings.wallets[walletIndex];

    // Decrypt private key
    let privateKey;
    try {
      privateKey = await decryptPrivateKey(
        selectedWallet.encrypted,
        selectedWallet.iv,
        selectedWallet.tag
      );
    } catch (error) {
      console.error("Error decrypting private key:", error);
      await ctx.reply(
        "⚠️ Failed to decrypt wallet private key. Order cancelled."
      );
      return;
    }

    // Place order
    await ctx.reply("Placing your order. This may take a moment...");
    
    const orderTypeNum = orderType === "buy" ? 1 : 2; // 1 for buy, 2 for sell
    console.log(orderTypeNum, quantity, ticker, privateKey, selectedWallet.address);
    const txHash = await placeOrder(
      orderTypeNum,
      quantity,
      ticker,
      privateKey,
      selectedWallet.address
    );

    if (txHash) {
      await ctx.reply(
        ` 🎉 Order successfully placed!\n\n` +
          `${orderType.toUpperCase()} ${quantity} ${ticker}\n` +
          `Transaction Hash: ${txHash.txHash}\n\n` +
          `You can view the transaction on the Injective Explorer.`,
        {
          reply_markup: new InlineKeyboard()
            .text("Place Another Order", "trade")
            .text("Main Menu", "main_menu"),
        }
      );
    } else {
      await ctx.reply(" ⚠️ Failed to place order. Please try again later.", {
        reply_markup: new InlineKeyboard()
          .text("Try Again", "trade")
          .text("Main Menu", "main_menu"),
      });
    }
  } catch (error) {
    console.error("Order confirmation error:", error);
    await ctx.reply(
      "⚠️ An error occurred while placing your order. Please try again later.",
      {
        reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
      }
    );
  }
}

// Import wallet conversation
async function handleImportWallet(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  try {
    // Check if database is connected
    if (!isDbConnected()) {
      await ctx.reply(
        "Database functionality is currently unavailable. The wallet import feature requires a database connection.",
        {
          reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
        }
      );
      return;
    }

    // Ask for wallet name
    await ctx.reply("🔐 Please enter a name for your wallet:");
    const nameResponse = await conversation.wait();
    const walletName = nameResponse.message?.text;

    if (!walletName || walletName.length < 1) {
      await ctx.reply("⚠️ Invalid wallet name. Import cancelled.");
      return;
    }

    // Check if wallet name already exists
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    if (
      userSettings &&
      userSettings.wallets.some((w) => w.name === walletName)
    ) {
      await ctx.reply(
        "A wallet with this name already exists. Please choose a different name."
      );
      return;
    }

    // Ask for private key
    await ctx.reply(
      `🔑 Please enter your private key to import your wallet:\n\n` +
        `⚠️ Note: Your private key will be encrypted and stored securely. It will never be shared with third parties.`,
      { parse_mode: "HTML" }
    );

    const pkResponse = await conversation.wait();
    const privateKey = pkResponse.message?.text?.trim();

    if (!privateKey || privateKey.length < 32) {
      await ctx.reply("⚠️ Invalid private key format. Import cancelled.");
      return;
    }

    try {
      // Validate private key by deriving address
      const wallet = new ethers.Wallet(privateKey);
      const ethereumAddress = wallet.address;
      const injectiveAddress = getInjectiveAddress(ethereumAddress);

      // Encrypt private key
      const { encrypted, iv, tag } = await encryptPrivateKey(privateKey);

      // Save wallet to database
      if (!userSettings) {
        await ctx.reply("User settings not found. Please try again later.");
        return;
      }

      // Add wallet to user's wallets
      const isFirstWallet = userSettings.wallets.length === 0;

      userSettings.wallets.push({
        name: walletName,
        address: injectiveAddress,
        encrypted,
        iv,
        tag,
      });

      // Set as default wallet if it's the first one
      if (isFirstWallet) {
        userSettings.tradingPreferences.defaultWallet = injectiveAddress;
      }

      await userSettings.save();

      // Get balance
      const balance = await getInjectiveBalance(injectiveAddress);

      await ctx.reply(
        ` 📈 Wallet "${walletName}" imported successfully! 🎉\n\n` +
          `Address: ${injectiveAddress}\n` +
          `Balance: ${balance}\n` +
          `Status: ${isFirstWallet ? "(Default Wallet)" : ""}`,
        {
          reply_markup: new InlineKeyboard()
            .text("View Wallets", "wallets")
            .text("Main Menu", "main_menu"),
        }
      );
    } catch (error) {
      console.error("Error importing wallet:", error);
      await ctx.reply(
        "⚠️ Invalid private key. Please check your key and try again."
      );
    }
  } catch (error) {
    console.error("Error in import wallet conversation:", error);
    await ctx.reply(
      "⚠️ An error occurred while importing your wallet. Please try again later."
    );
  }
}

const handleCreateWalletConversation = createConversation(
  handleCreateWallet,
  "handleCreateWallet"
);
const handleImportWalletConversation = createConversation(
  handleImportWallet,
  "handleImportWallet"
);
const marketSearchConversation = createConversation(
  marketSearch,
  "marketSearch"
);
const portfolioConversation = createConversation(
  handlePortfolioConversion,
  "portfolio"
);
const buyOrderConversation = createConversation(
  (conversation: Conversation<MyContext>, ctx: MyContext) =>
    handleTradeConversation(conversation, ctx, "buy"),
  "buyOrder"
);
const sellOrderConversation = createConversation(
  (conversation: Conversation<MyContext>, ctx: MyContext) =>
    handleTradeConversation(conversation, ctx, "sell"),
  "sellOrder"
);
const walletSelectionConversation = createConversation(
  async (conversation: Conversation<MyContext>, ctx: MyContext) => {
    // Get parameters from session
    const walletIndex = conversation.session.walletIndex || 0;
    const orderType = conversation.session.orderType || "buy";
    const ticker = conversation.session.ticker || "";

    if (!ticker) {
      await ctx.reply("Invalid ticker. Trading cancelled.");
      return;
    }

    return handleWalletSelection(
      conversation,
      ctx,
      walletIndex,
      orderType,
      ticker
    );
  },
  "walletSelection"
);
const handleDeleteWalletConversation = createConversation(
  handleDeleteWallet,
  "handleDeleteWallet"
);
const editWalletNameConversation = createConversation(
  async (conversation: Conversation<MyContext>, ctx: MyContext) => {
    console.log("Edit wallet name conversation started");
    
    // Check if we have a session
    if (!ctx.session) {
      console.log("Session is undefined");
      await ctx.reply("⚠️ Session error. Please try again.");
      return;
    }
    
    console.log("Session data:", JSON.stringify(ctx.session));
    
    // Get the walletIndex from the session
    const walletIndex = ctx.session.walletIndex;
    console.log("Wallet index:", walletIndex);

    if (walletIndex === undefined) {
      console.log("Wallet index is undefined");
      await ctx.reply("⚠️ Invalid wallet selection.");
      return;
    }

    // Verify the wallet exists
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    
    if (!userSettings || !userSettings.wallets[walletIndex]) {
      console.log("Wallet not found in database");
      await ctx.reply("⚠️ Wallet not found. Please try again.");
      return;
    }
    
    const currentWalletName = userSettings.wallets[walletIndex].name;
    
    await ctx.reply(`🔐 Please enter a new name for wallet "${currentWalletName}":`);
    const response = await conversation.wait();
    const newWalletName = response.message?.text;

    if (!newWalletName || newWalletName.length < 1) {
      await ctx.reply("Invalid wallet name. Please try again.");
      return;
    }

    userSettings.wallets[walletIndex].name = newWalletName;
    await userSettings.save();

    await ctx.reply(`✅ Wallet name updated to "${newWalletName}"`);

    // await handleSettingsSubOption(ctx, "settings_wallets");
  },
  "edit_wallet_name"
);

function setupBotConversations(bot: Bot<MyContext>) {
  bot.use(handleCreateWalletConversation);
  bot.use(handleImportWalletConversation);
  bot.use(handleDeleteWalletConversation);
  bot.use(marketSearchConversation);
  bot.use(portfolioConversation);
  // Removed settings conversation
  bot.use(buyOrderConversation);
  bot.use(sellOrderConversation);
  bot.use(walletSelectionConversation);
  bot.use(editWalletNameConversation);
}

// Register all conversations before setting up handlers
setupBotConversations(bot);

// Add error handler
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  console.error(err.error);
});

// Utility function to safely enter a conversation
async function safelyEnterConversation(
  ctx: MyContext,
  conversationName: string,
  options?: {
    walletIndex?: number;
    orderType?: "buy" | "sell";
    ticker?: string;
  }
) {
  try {
    console.log(`Entering conversation: ${conversationName} with options:`, options);
    
    if (!ctx.conversation) {
      console.error("Conversation object is undefined");
      await ctx.answerCallbackQuery("Conversation setup error");
      return false;
    }

    // Update session with options
    if (options) {
      console.log("Updating session with options:", options);
      if (options.walletIndex !== undefined) {
        ctx.session.walletIndex = options.walletIndex;
        console.log(`Set session.walletIndex to ${options.walletIndex}`);
      }
      if (options.orderType !== undefined) {
        ctx.session.orderType = options.orderType;
      }
      if (options.ticker !== undefined) {
        ctx.session.ticker = options.ticker;
      }
    }

    console.log("Session before entering conversation:", JSON.stringify(ctx.session));
    await ctx.conversation.enter(conversationName, options);
    return true;
  } catch (error) {
    console.error(`Error entering conversation ${conversationName}:`, error);
    await ctx.answerCallbackQuery(
      `Failed to enter ${conversationName} conversation`
    );
    return false;
  }
}

// Update the callback query handler to use the safe conversation entry
bot.on("callback_query:data", async (ctx) => {
  if (!ctx.callbackQuery.data) {
    await ctx.answerCallbackQuery("Invalid callback");
    return;
  }

  const data = ctx.callbackQuery.data;
  console.log(`Callback received: ${data}`);

  try {
    // Initialize session if needed
    if (!ctx.session) {
      ctx.session = {};
    }
    
    if (data === "delete_wallet") {
      await safelyEnterConversation(ctx, "handleDeleteWallet");
      return;
    }

    // Special handling for edit_wallet_X format
    if (data.startsWith("edit_wallet_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing wallet rename for index: ${walletIndex}`);
        
        // Set the walletIndex directly in the session
        ctx.session.walletIndex = walletIndex;
        console.log(`Set session.walletIndex to ${walletIndex}`);
        
        // Enter the conversation
        if (ctx.conversation) {
          await ctx.conversation.enter("edit_wallet_name");
        } else {
          console.error("Conversation object is undefined");
          await ctx.answerCallbackQuery("Conversation setup error");
        }
        return;
      }
    }

    // Special handling for select_delete_wallet_X format
    if (data.startsWith("select_delete_wallet_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing wallet deletion for index: ${walletIndex}`);
        await handleWalletDeletion(ctx, walletIndex);
        return;
      }
    }

    // Special handling for wallet_details_X format
    if (data.startsWith("wallet_details_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing wallet details for index: ${walletIndex}`);
        await handleWalletDetails(ctx, walletIndex);
        return;
      }
    }

    // Special handling for show_private_key_X format
    if (data.startsWith("show_private_key_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing show private key for index: ${walletIndex}`);
        await handleShowPrivateKey(ctx, walletIndex);
        return;
      }
    }

    // Special handling for set_default_wallet_X format
    if (data.startsWith("set_default_wallet_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing set default wallet for index: ${walletIndex}`);
        await handleSetDefaultWallet(ctx, walletIndex);
        return;
      }
    }

    // Special handling for confirm_delete_wallet_X format
    if (data.startsWith("confirm_delete_wallet_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing confirm delete wallet for index: ${walletIndex}`);
        await showPrivateKeyAndDeleteWallet(ctx, walletIndex);
        return;
      }
    }

    // Special handling for delete_wallet_X format
    if (data.startsWith("delete_wallet_")) {
      const walletIndex = parseInt(data.split("_").pop() || "");
      if (!isNaN(walletIndex)) {
        console.log(`Processing final wallet deletion for index: ${walletIndex}`);
        await finalizeWalletDeletion(ctx, walletIndex);
        return;
      }
    }

    const [action, ...params] = data.split("_");
    const param = params.join("_");

    switch (action) {
      case "portfolio":
        await safelyEnterConversation(ctx, "portfolio");
        break;

      case "search":
        if (param === "markets") {
          await safelyEnterConversation(ctx, "marketSearch");
        }
        break;

      case "trade":
        await handleMarketSelection(ctx);
        break;

      case "wallets":
        await handleWallets(ctx);
        break;

      case "create":
        if (param === "wallet") {
          await safelyEnterConversation(ctx, "handleCreateWallet");
        }
        break;

      case "import":
        if (param === "wallet") {
          await safelyEnterConversation(ctx, "handleImportWallet");
        }
        break;

      case "buy_order":
        await safelyEnterConversation(ctx, "buyOrder");
        break;

      case "sell_order":
        await safelyEnterConversation(ctx, "sellOrder");
        break;

      case "buy":
      case "sell":
        const ticker = params.join("_");
        if (ticker) {
          await safelyEnterConversation(ctx, action === "buy" ? "buyOrder" : "sellOrder", {
            orderType: action as "buy" | "sell",
            ticker,
          });
        }
        break;

      case "select":
        if (param.startsWith("wallet")) {
          const parts = param.split("_");
          const walletIndex = parseInt(parts[1]);
          const orderType = parts[2] as "buy" | "sell";
          const ticker = parts.slice(3).join("_");

          // Store in session for the conversation
          ctx.session.walletIndex = walletIndex;
          ctx.session.orderType = orderType;
          ctx.session.ticker = ticker;

          await safelyEnterConversation(ctx, "walletSelection");
        }
        break;

      case "confirm":
        if (params.length >= 4) {
          const orderType = params[0] as "buy" | "sell";
          const quantity = parseFloat(params[1]);
          const walletIndex = parseInt(params[params.length - 1]);
          const ticker = params.slice(2, params.length - 1).join("_");

          await handleOrderConfirmation(
            ctx,
            orderType,
            quantity,
            ticker,
            walletIndex
          );
        }
        break;
      case "main":
        if (param === "menu") {
          const firstName = ctx.from?.first_name || "";
          const username = ctx.from?.username || "User";

          await ctx.editMessageText(
            `🚀 Welcome to the Injective Trading Bot, ${
              firstName || username
            }! \n\n` +
              `This bot allows you to trade on the Injective Chain directly from Telegram.\n\n` +
              `Select an option from the menu below:`,
            { reply_markup: mainMenuKeyboard }
          );
        }
        break;

      case "all":
        if (param === "markets") {
          const filePath = path.resolve(
            __dirname,
            "../../../src/SpotMarket.json"
          );
          const data = await fs.promises.readFile(filePath, "utf8");
          const markets = JSON.parse(data);

          let message = " Available Markets:\n\n";
          const keyboard = new InlineKeyboard();

          markets.slice(0, 2).forEach((market: any) => {
            message += `${market.ticker}\n`;
            keyboard.text(market.ticker, `market_${market.ticker}`).row();
          });

          keyboard
            .text("Search Markets", "search_markets")
            .text("Back", "market_info");

          await ctx.editMessageText(message, { reply_markup: keyboard });
        }
        break;

      case "market":
        if (param === "info") {
          await handleMarketInfo(ctx);
        } else if (param.startsWith("details")) {
          const ticker = params.slice(1).join("_");
          await handleMarketInfo(ctx, ticker);
        }
        break;

      default:
        console.log(`Unhandled callback action: ${action}`);
        await ctx.answerCallbackQuery("Unknown action");
        break;
    }

    if (ctx.callbackQuery?.message) {
      await ctx.answerCallbackQuery();
    }
  } catch (error) {
    console.error("Callback query error:", error);

    try {
      await ctx.answerCallbackQuery(
        "⚠️ An unexpected error occurred. Please try again."
      );
    } catch (answerError) {
      console.error("Failed to answer callback query:", answerError);
    }
  }
});

// Separate handler for settings sub-options
// Removed the handleSettingsSubOption function

// Handle market selection
async function handleMarketSelection(ctx: MyContext) {
  try {
    await ctx.editMessageText("💹 Trading Menu\nSelect your action:", {
      reply_markup: tradingKeyboard,
    });
  } catch (error) {
    console.error("Error in handleMarketSelection:", error);
    await ctx.reply(
      "⚠️ An error occurred while loading markets. Please try again."
    );
  }
}

// Main menu keyboard
const mainMenuKeyboard = new InlineKeyboard()
  .text("💹 Trade", "trade")
  .text("👛 Wallets", "wallets")
  .text("📊 Portfolio", "portfolio");

// Trading keyboard
const tradingKeyboard = new InlineKeyboard()
  .text("💰 Buy", "buy_order")
  .text("💸 Sell", "sell_order")
  .row()
  .text("🔍 Search Markets", "search_markets")
  .text("◀️ Back", "main_menu");

// Settings keyboard
const settingsKeyboard = new InlineKeyboard()
  .text("🔒 Security", "security")
  .text("🔧 Preferences", "preferences")
  .row()
  .text("🔔 Notifications", "notifications")
  .text("◀️ Back", "main_menu");

// Wallet management keyboard
const walletKeyboard = new InlineKeyboard()
  .text("➕ New Wallet", "create_wallet")
  .text("✏️ Rename Wallet", "rename_wallet")
  .row()
  .text("🔄 Switch Wallet", "switch_wallet")
  .text("🗑️ Delete Wallet", "wallet_delete")
  .row()
  .text("◀️ Back", "main_menu");

// Market info keyboard
const marketInfoKeyboard = new InlineKeyboard()
  .text("💲 Price Info", "price_info")
  .text("📈 Volume", "volume_info")
  .row()
  .text("📊 Market Depth", "depth_info")
  .text("🔄 Recent Trades", "recent_trades")
  .row()
  .text("🔄 Change Market", "select_market")
  .text("◀️ Back to Trading", "trade");

// Market selection keyboard
const marketSelectionKeyboard = new InlineKeyboard()
  .text("🔍 Search Markets", "search_markets")
  .row()
  .text("📋 All Markets", "all_markets")
  .row()
  .text("📊 Top Volume", "top_volume_markets")
  .row()
  .text("🔥 Trending", "trending_markets")
  .row()
  .text("◀️ Back", "trade");

// Helper function to check if DB is connected
isDbConnected();

// Command handlers
bot.command("start", async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.reply("Error: User information not found.");
      return;
    }

    let userDocument = null;
    if (isDbConnected()) {
      userDocument = await User.findOne({ telegramId: ctx.from.id });

      if (!userDocument) {
        userDocument = new User({
          telegramId: ctx.from.id.toString(),
          userName: ctx.from.username || `user_${ctx.from.id}`,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
        await userDocument.save();
      }
    }

    const welcomeMessage = `Welcome ${
      ctx.from.first_name || ""
    }! I'm your Injective Trading Bot.
I'll help you trade on the Injective Protocol directly from Telegram.`;

    await ctx.reply(welcomeMessage, {
      reply_markup: mainMenuKeyboard,
    });
  } catch (error) {
    console.error("Start command error:", error);
    await ctx.reply("⚠️ An error occurred. Please try again later.");
  }
});

bot.command("help", async (ctx) => {
  if (!ctx.message?.text) {
    return;
  }

  const helpText = `
Here are the available commands:

/start - Start the bot and show main menu
/help - Show this help message
/wallet - Manage your wallets
/trade - Access trading menu
/settings - Configure your preferences
/portfolio - View your portfolio
/balance - Check your wallet balance
/price <ticker> - Get current price for a market (e.g., /price INJ/USDT)
/search <ticker> - Search for a market (e.g., /search INJ/USDT)

For more detailed help, visit our documentation or contact support.
`;
  await ctx.reply(helpText);
});

bot.command("wallet", async (ctx) => {
  if (!ctx.message?.text) {
    return;
  }

  await handleWallets(ctx);
});

bot.command("trade", async (ctx) => {
  if (!ctx.message?.text) {
    return;
  }

  await ctx.reply("💹 Trading Menu\nSelect your action:", {
    reply_markup: tradingKeyboard,
  });
});

bot.command("settings", async (ctx) => {
  if (!ctx.message?.text) {
    return;
  }

  await ctx.reply("⚙️ Settings Menu\nCustomize your experience:", {
    reply_markup: settingsKeyboard,
  });
});

bot.command("price", async (ctx) => {
  if (!ctx.message?.text) {
    return;
  }

  try {
    const parts = ctx.message.text.split(" ");
    const ticker = parts.length > 1 ? parts[1] : null;

    if (!ticker) {
      await ctx.reply(
        "Please specify a market ticker. Example: /price INJ/USDT"
      );
      return;
    }

    const marketDetails = await getMarketDetails(ticker);
    await ctx.reply(
      ` Market: ${ticker}\n` +
        `Current Price: ${marketDetails.price}\n` +
        `24h High: ${marketDetails.highPrice}\n` +
        `24h Low: ${marketDetails.lowPrice}\n` +
        `24h Open: ${marketDetails.open}\n` +
        `Average Buy Price: ${marketDetails.averageBuyPrice}\n` +
        `Average Sell Price: ${marketDetails.averageSellPrice}`
    );
  } catch (error) {
    console.error("Price command error:", error);
    if (error instanceof Error) {
      await ctx.reply(`⚠️ Error: ${error.message}`);
    } else {
      await ctx.reply(
        "⚠️ An error occurred while fetching the price. Please try again later."
      );
    }
  }
});

bot.command("balance", async (ctx) => {
  if (!ctx.message?.text) {
    return;
  }

  try {
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    if (!userSettings || userSettings.wallets.length === 0) {
      await ctx.reply(
        "Please create a wallet first using the /wallet command."
      );
      return;
    }

    const balance = await getInjectiveBalance(userSettings.wallets[0].address);
    await ctx.reply(` Your wallet balance:\n${balance}`);
  } catch (error) {
    console.error("Balance command error:", error);
    await ctx.reply(
      "⚠️ An error occurred while fetching your balance. Please try again."
    );
  }
});

bot.command("search", async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const searchTerm = ctx.message?.text.split(" ").slice(1).join(" ");

  if (searchTerm && searchTerm.trim().length > 0) {
    await handleMarketSearch(ctx, searchTerm.trim().toUpperCase());
  } else {
    await ctx.conversation.enter("marketSearch");
  }
});

// Market info handler
bot.callbackQuery("market_info", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(" Select a market to view:", {
    reply_markup: marketSelectionKeyboard,
  });
});

// All markets handler
bot.callbackQuery("all_markets", async (ctx) => {
  await ctx.answerCallbackQuery();

  try {
    const filePath = path.resolve(
      __dirname,
      "../../../src/SpotMarket.json"
    );
    const data = await fs.promises.readFile(filePath, "utf8");
    const markets = JSON.parse(data);

    let message = " Available Markets:\n\n";
    const keyboard = new InlineKeyboard();

    markets.slice(0, 2).forEach((market: any) => {
      message += `${market.ticker}\n`;
      keyboard.text(market.ticker, `market_${market.ticker}`).row();
    });

    keyboard
      .text("Search Markets", "search_markets")
      .text("Back", "market_info");

    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (error) {
    console.error("All markets error:", error);
    await ctx.reply("⚠️ Error fetching markets. Please try again.");
  }
});

// Market details handler
bot.callbackQuery(/market_details_(.+)/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const marketTicker = ctx.match[1];

  try {
    const marketDetails = await getMarketDetails(marketTicker);

    if (!marketDetails) {
      await ctx.reply(`⚠️ Market ${marketTicker} not found`);
      return await handleMarketSelection(ctx);
    }

    const detailsMessage = ` 📊 Market Details for ${marketTicker}
 Price Information
Current Price: ${marketDetails.price.toFixed(2)} ${marketDetails.quoteSymbol}
24h Change: ${marketDetails.price.toFixed(2)}%
24h High: ${marketDetails.highPrice.toFixed(2)} ${marketDetails.quoteSymbol}
24h Low: ${marketDetails.lowPrice.toFixed(2)} ${marketDetails.quoteSymbol}

 Volume Information
24h Volume: ${marketDetails.lowPrice.toFixed(2)} ${marketDetails.quoteSymbol}

 Market Depth
Average Buy Price: ${marketDetails.averageBuyPrice} ${marketDetails.quoteSymbol}
Average Sell Price: ${marketDetails.averageSellPrice} ${
      marketDetails.quoteSymbol
    }
Spread: ${((( (marketDetails.averageSellPrice ?? 0) - (marketDetails.averageBuyPrice ?? 0)) / (marketDetails.averageBuyPrice ?? 1)) * 100).toFixed(2)}
%

 Trend: ${calculatePriceTrend(marketDetails)}

Select an option below for more detailed information.`;

    const keyboard = new InlineKeyboard()
      .text(" Buy", `buy_${marketTicker}`)
      .text(" Sell", `sell_${marketTicker}`)
      .row()
      .text(" Back", "all_markets");

    await ctx.editMessageText(detailsMessage, {
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error(`Market details error for ${marketTicker}:`, error);
    await ctx.reply("⚠️ Error fetching market details. Please try again.");
  }
});

// Handle wallets
async function handleWallets(ctx: MyContext) {
  try {
    // Check if database is connected
    if (!isDbConnected()) {
      await ctx.reply(
        "Database functionality is currently unavailable. The wallet feature requires a database connection.",
        {
          reply_markup: new InlineKeyboard().text(" Back", "main_menu"),
        }
      );
      return;
    }

    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });

    if (!userSettings || userSettings.wallets.length === 0) {
      await ctx.reply(
        "You don't have any wallets yet. Would you like to create or import one?",
        {
          reply_markup: new InlineKeyboard()
            .text("Create Wallet", "create_wallet")
            .text("Import Wallet", "import_wallet")
            .row()
            .text(" Back", "main_menu"),
        }
      );
      return;
    }

    // Create wallet list keyboard
    const keyboard = new InlineKeyboard();

    userSettings.wallets.forEach((wallet, index) => {
      const isDefault =
        wallet.address === userSettings.tradingPreferences.defaultWallet;
      keyboard
        .text(
          `${wallet.name}${isDefault ? " (Default)" : ""}`,
          `wallet_details_${index}`
        )
        .row();
    });

    keyboard
      .text("Create Wallet", "create_wallet")
      .text("Import Wallet", "import_wallet")
      .row()
      .text("🗑️ Delete Wallet", "wallet_delete")
      .row()
      .text("◀️ Back", "main_menu");

    await ctx.reply("👛 Your wallets:", { reply_markup: keyboard });
  } catch (error) {
    console.error("Error handling wallets:", error);
    await ctx.reply(
      "⚠️ An error occurred while retrieving your wallets. Please try again later."
    );
  }
}

// Wallet details handler
async function handleWalletDetails(ctx: MyContext, walletIndex: number) {
  try {
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });

    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.reply("Wallet not found.");
      return;
    }

    const wallet = userSettings.wallets[walletIndex];
    const isDefault =
      wallet.address === userSettings.tradingPreferences.defaultWallet;
    const balance = await getInjectiveBalance(wallet.address);
    
    // Create wallet details keyboard
    const detailsKeyboard = new InlineKeyboard()
      .text("✏️ Rename", `edit_wallet_${walletIndex}`)
      .text("🗑️ Delete", `select_delete_wallet_${walletIndex}`)
      .row()
      .text("🔑 Show Private Key", `show_private_key_${walletIndex}`)
      .row();
    
    if (!isDefault) {
      detailsKeyboard.text("✅ Set as Default", `set_default_wallet_${walletIndex}`);
    }
    
    detailsKeyboard.row().text("◀️ Back", "wallets");
    
    await ctx.editMessageText(
      `👛 Wallet Details:\n\n` +
      `Name: ${wallet.name}\n` +
      `Address: ${wallet.address}\n` +
      `Status: ${isDefault ? "Default Wallet" : "Regular Wallet"}\n` +
      `Balance: ${balance}`,
      { reply_markup: detailsKeyboard }
    );
  } catch (error) {
    console.error("Error handling wallet details:", error);
    await ctx.reply(
      "⚠️ An error occurred while retrieving wallet details. Please try again later."
    );
  }
}

// Show private key handler
async function handleShowPrivateKey(ctx: MyContext, walletIndex: number) {
  try {
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });

    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.reply("Wallet not found.");
      return;
    }

    const wallet = userSettings.wallets[walletIndex];

    try {
      const privateKey = await decryptPrivateKey(
        wallet.encrypted,
        wallet.iv,
        wallet.tag
      );

      await ctx.reply(
        `🔑 Private Key for "${wallet.name}"\n\n` +
          `⚠️ WARNING: Never share your private key with anyone!\n\n` +
          `${privateKey}`,
        {
          reply_markup: new InlineKeyboard()
            .text("🔒 Hide Key & Return", `wallet_details_${walletIndex}`),
        }
      );

      // Delete message after 60 seconds for security
      setTimeout(async () => {
        try {
          await ctx.deleteMessage();
        } catch (error) {
          console.error("Failed to delete private key message:", error);
        }
      }, 60000);
    } catch (error) {
      console.error("Error decrypting private key:", error);
      await ctx.reply(
        "⚠️ Failed to decrypt wallet private key. Please try again later."
      );
    }
  } catch (error) {
    console.error("Error showing private key:", error);
    await ctx.reply(
      "⚠️ An error occurred while retrieving your private key. Please try again later."
    );
  }
}

// Set default wallet handler
async function handleSetDefaultWallet(ctx: MyContext, walletIndex: number) {
  try {
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });

    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.reply("Wallet not found.");
      return;
    }

    const wallet = userSettings.wallets[walletIndex];
    userSettings.tradingPreferences.defaultWallet = wallet.address;
    await userSettings.save();

    await ctx.reply(`✅ Default wallet set to "${wallet.name}" 📈`);
    await handleWalletDetails(ctx, walletIndex);
  } catch (error) {
    console.error("Error setting default wallet:", error);
    await ctx.reply(
      "⚠️ An error occurred while setting your default wallet. Please try again later."
    );
  }
}

// Create wallet conversation handler
async function handleCreateWallet(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  try {
    if (!ctx.from?.username || !ctx.from.id) {
      await ctx.reply("Error: User information not found.");
      return;
    }

    let userSettings = await UserSettings.findOne({
      userId: ctx.from.id.toString(),
    });
    if (!userSettings) {
      userSettings = await UserSettings.create({
        userId: ctx.from.id.toString(),
        userName: ctx.from.username,
        wallets: [],
        tradingPreferences: {},
        notifications: {},
      });
    }

    await ctx.reply("🔐 Please enter a name for your new wallet:");

    const nameResponse = await conversation.wait();

    if (!nameResponse.message?.text) {
      await ctx.reply("Invalid input. Please try again.");
      return;
    }

    const walletName = SecurityUtils.sanitizeInput(nameResponse.message.text);

    if (!SecurityUtils.validateWalletName(walletName)) {
      await ctx.reply(
        "Invalid wallet name. Please use 3-30 characters, only letters, numbers, and underscores."
      );
      return;
    }

    const existingWallet = userSettings.wallets.find(
      (w) => w.name === walletName
    );
    if (existingWallet) {
      await ctx.reply(
        "A wallet with this name already exists. Please choose a different name."
      );
      return;
    }

    const { privateKey, injectiveAddress } = await createInjectiveWallet();
    const { encrypted, iv, tag } = encryptPrivateKey(privateKey);

    const isFirstWallet = userSettings.wallets.length === 0;

    userSettings.wallets.push({
      name: walletName,
      address: injectiveAddress,
      encrypted,
      iv,
      tag,
    });

    if (isFirstWallet) {
      userSettings.tradingPreferences.defaultWallet = injectiveAddress;
    }

    await userSettings.save();

    const balance = await getInjectiveBalance(injectiveAddress);

    await ctx.reply(
      ` 📈 Wallet "${walletName}" created successfully! 🎉\n\n` +
        `Address: ${injectiveAddress}\n` +
        `Balance: ${balance}\n` +
        `Status: ${isFirstWallet ? "(Default Wallet)" : ""}`,
      { reply_markup: walletKeyboard }
    );
  } catch (error) {
    console.error("Create wallet error:", error);
    await ctx.reply(
      "⚠️ An error occurred while creating your wallet. Please try again."
    );
  }
}

// Handle market info
async function handleMarketInfo(ctx: MyContext, ticker?: string) {
  try {
    if (!ctx.chat) {
      await ctx.answerCallbackQuery("Error: Chat information not found.");
      return;
    }

    if (!ticker) {
      return await handleMarketSelection(ctx);
    }

    const marketData = await getMarketDataByTicker(ticker);

    if (!marketData) {
      await ctx.answerCallbackQuery(`⚠️ Market ${ticker} not found`);
      return await handleMarketSelection(ctx);
    }

    const message = formatMarketOverview(marketData, ticker);

    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(message, {
        reply_markup: marketInfoKeyboard,
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(message, {
        reply_markup: marketInfoKeyboard,
        parse_mode: "HTML",
      });
    }
  } catch (error) {
    console.error("Market info error:", error);
    const errorMessage =
      "⚠️ Failed to fetch market information from SpotMarket.json. Please try again later.";
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery(errorMessage);
    } else {
      await ctx.reply(errorMessage);
    }
  }
}

// Format market overview
function formatMarketOverview(marketData: any, ticker: string) {
  return ` 📊 Market Overview: ${ticker}\n
 Price Information
Current Price: ${marketData.price?.toFixed(2) || "N/A"} ${
    marketData.quoteToken || marketData.quoteSymbol || ""
  }
24h Change: ${
    marketData.priceChange?.toFixed(2) ||
    (((marketData.price - marketData.open) / marketData.open) * 100).toFixed(
      2
    ) ||
    "N/A"
  }%
24h High: ${
    marketData.high?.toFixed(2) || marketData.highPrice?.toFixed(2) || "N/A"
  } ${marketData.quoteToken || marketData.quoteSymbol || ""}
24h Low: ${
    marketData.low?.toFixed(2) || marketData.lowPrice?.toFixed(2) || "N/A"
  } ${marketData.quoteToken || marketData.quoteSymbol || ""}

 Volume Information
24h Volume: ${
    marketData.volume?.toFixed(2) || marketData.lowPrice?.toFixed(2) || "N/A"
  } ${marketData.quoteToken || marketData.quoteSymbol || ""}

 Market Depth
Average Buy Price: ${marketData.averageBuyPrice || "N/A"} ${
    marketData.quoteToken || marketData.quoteSymbol || ""
  }
Average Sell Price: ${marketData.averageSellPrice || "N/A"} ${
    marketData.quoteToken || marketData.quoteSymbol || ""
  }
Spread: ${
    marketData.averageBuyPrice && marketData.averageSellPrice
      ? (
          ((parseFloat(marketData.averageSellPrice) -
            parseFloat(marketData.averageBuyPrice)) /
            parseFloat(marketData.averageBuyPrice)) *
          100
        ).toFixed(2)
      : "N/A"
  }%

 Trend: ${calculatePriceTrend(marketData)}

Select an option below for more detailed information.`;
}

// Calculate price trend indicator
function calculatePriceTrend(marketData: any): string {
  const priceChange = marketData.priceChange;

  if (priceChange > 5) {
    return " 🚀 Strong Uptrend";
  } else if (priceChange > 2) {
    return " ⬆️ Moderate Uptrend";
  } else if (priceChange > 0) {
    return " ➡️ Slight Uptrend";
  } else if (priceChange === 0) {
    return " ⬅️ Sideways";
  } else if (priceChange > -2) {
    return " ⬇️ Slight Downtrend";
  } else if (priceChange > -5) {
    return " ⬇️ Moderate Downtrend";
  } else {
    return " 📉 Strong Downtrend";
  }
}

// Handle market search (non-conversation version)
async function handleMarketSearch(ctx: MyContext, searchTerm?: string) {
  try {
    if (!searchTerm) {
      await ctx.reply(
        "🔍 Please enter the market ticker you want to search for (e.g., INJ/USDT):"
      );
      return;
    }

    await getSpotMarketData();

    const filePath = path.resolve(__dirname, "../../../src/SpotMarket.json");
    const data = await fs.promises.readFile(filePath, "utf8");
    const markets = JSON.parse(data);

    const matchingMarkets = markets
      .filter(
        (m: any) =>
          m.ticker?.includes(searchTerm) ||
          m.baseToken?.symbol?.includes(searchTerm) ||
          m.quoteToken?.symbol?.includes(searchTerm)
      )
      .slice(0, 5);

    if (matchingMarkets.length === 0) {
      await ctx.reply(`⚠️ No markets found matching "${searchTerm}".`);
      return;
    }

    const keyboard = new InlineKeyboard();
    matchingMarkets.forEach((market: any) => {
      keyboard.text(market.ticker, `market_${market.ticker}`);
      keyboard.row();
    });
    keyboard.text("Back", "market_info");

    await ctx.reply(
      `Found ${matchingMarkets.length} markets matching "${searchTerm}":`,
      {
        reply_markup: keyboard,
      }
    );
  } catch (error) {
    console.error("Market search error:", error);
    await ctx.reply("⚠️ Error searching markets. Please try again.");
  }
}

// Market search conversation handler
async function marketSearch(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  try {
    await ctx.reply(
      "🔍 Please enter the market ticker you want to search for (e.g., INJ/USDT):"
    );
    const response = await conversation.wait();
    
    if (!response.message?.text) {
      await ctx.reply("Invalid input. Please try again.");
      return;
    }
    
    const searchTerm = response.message.text.toUpperCase();
    await handleMarketSearch(ctx, searchTerm);
  } catch (error) {
    console.error("Market search conversation error:", error);
    await ctx.reply("⚠️ Error during market search. Please try again.");
  }
}

// Helper function to get market data by ticker
async function getMarketDataByTicker(ticker: string) {
  try {
    const marketDetails = await getMarketDetails(ticker);

    if (!marketDetails) {
      throw new Error(`Market not found for ticker: ${ticker}`);
    }

    return {
      price: marketDetails.price,
      priceChange:
        (marketDetails.price - marketDetails.open) / (marketDetails.open * 100),
      high: marketDetails.highPrice,
      low: marketDetails.lowPrice,
      volume: 0,
      trades: 0,
      topBid: marketDetails.averageBuyPrice,
      topAsk: marketDetails.averageSellPrice,
      quoteToken: marketDetails.quoteSymbol,
    };
  } catch (error) {
    console.error(`Error getting market data for ${ticker}:`, error);
    throw error;
  }
}

// Market Alert Types
interface MarketAlert {
  userId: string;
  ticker: string;
  targetPrice: number;
  condition: "above" | "below";
  active: boolean;
  createdAt: Date;
}

// Order Tracking Types
interface OrderTrack {
  userId: string;
  orderId: string;
  ticker: string;
  type: "buy" | "sell";
  quantity: number;
  price: number;
  status: "pending" | "filled" | "cancelled";
  createdAt: Date;
}

// In-memory storage for alerts and orders
const marketAlerts = new Map<string, MarketAlert[]>();
const orderTracks = new Map<string, OrderTrack[]>();

// Alert management functions
async function createMarketAlert(
  ctx: MyContext,
  ticker: string,
  targetPrice: number,
  condition: "above" | "below"
) {
  if (!ctx.from) return;

  const alert: MarketAlert = {
    userId: ctx.from.id.toString(),
    ticker,
    targetPrice,
    condition,
    active: true,
    createdAt: new Date(),
  };

  const userAlerts = marketAlerts.get(ctx.from.id.toString()) || [];
  userAlerts.push(alert);
  marketAlerts.set(ctx.from.id.toString(), userAlerts);

  await ctx.reply(
    `Alert set for ${ticker} when price goes ${condition} ${targetPrice}`
  );
}

async function checkMarketAlerts() {
  for (const [userId, alerts] of marketAlerts.entries()) {
    for (const alert of alerts) {
      if (!alert.active) continue;

      try {
        const marketData = await getMarketDataByTicker(alert.ticker);
        const currentPrice = marketData.price;

        if (
          (alert.condition === "above" && currentPrice > alert.targetPrice) ||
          (alert.condition === "below" && currentPrice < alert.targetPrice)
        ) {
          const message =
            `Price Alert: ${alert.ticker}\n` +
            `Target: ${alert.condition} ${alert.targetPrice}\n` +
            `Current Price: ${currentPrice}`;

          alert.active = false;

          await bot.api.sendMessage(userId, message);
        }
      } catch (error) {
        console.error(`Error checking alert for ${alert.ticker}:`, error);
      }
    }
  }
}

// Order tracking functions
async function trackOrder(
  ctx: MyContext,
  orderId: string,
  ticker: string,
  type: "buy" | "sell",
  quantity: number,
  price: number
) {
  if (!ctx.from) return;

  const order: OrderTrack = {
    userId: ctx.from.id.toString(),
    orderId,
    ticker,
    type,
    quantity,
    price,
    status: "pending",
    createdAt: new Date(),
  };

  const userOrders = orderTracks.get(ctx.from.id.toString()) || [];
  userOrders.push(order);
  orderTracks.set(ctx.from.id.toString(), userOrders);

  await ctx.reply(
    `Order tracked:\n${type.toUpperCase()} ${quantity} ${ticker} @ ${price}`
  );
}

async function updateOrderStatus(
  orderId: string,
  status: "filled" | "cancelled"
) {
  for (const orders of orderTracks.values()) {
    const order = orders.find((o) => o.orderId === orderId);
    if (order) {
      order.status = status;
      await bot.api.sendMessage(order.userId, `Order ${orderId} ${status}`);
      break;
    }
  }
}

// Add alert commands
bot.command("alert", async (ctx) => {
  const args = ctx.message?.text.split(" ");
  if (!args || args.length !== 4) {
    await ctx.reply(
      "Usage: /alert <ticker> <above|below> <price>\n" +
        "Example: /alert INJ/USDT above 100"
    );
    return;
  }

  const [_, ticker, condition, price] = args;
  if (condition !== "above" && condition !== "below") {
    await ctx.reply("Condition must be either 'above' or 'below'");
    return;
  }

  const targetPrice = parseFloat(price);
  if (isNaN(targetPrice)) {
    await ctx.reply("Invalid price value");
    return;
  }

  await createMarketAlert(ctx, ticker, targetPrice, condition);
});

// Add order tracking to placeOrder function
const originalPlaceOrder = placeOrder;
async function placeOrderWithTracking(
  ctx: MyContext,
  buyOrSell: number,
  quantity: number,
  ticker: string,
  privateKey: string,
  walletAddress: string
) {
  try {
    const result = await originalPlaceOrder(
      buyOrSell,
      quantity,
      ticker,
      privateKey,
      walletAddress
    );
    if (result?.txHash) {
      await trackOrder(
        ctx,
        result.txHash,
        ticker,
        buyOrSell === 1 ? "buy" : "sell",
        quantity,
        0
      );
    }
    return result;
  } catch (error) {
    console.error("Error placing order with tracking:", error);
    throw error;
  }
}

// Replace placeOrder with tracked version
// placeOrder = placeOrderWithTracking;

// Start alert checking interval
setInterval(checkMarketAlerts, 60000);

// Add conversation handlers
bot.use(async (ctx, next) => {
  if (ctx.message?.text) {
    ctx.message.text = SecurityUtils.sanitizeInput(ctx.message.text);
  }
  await next();
});

// Export bot and context type for use in other files
export { bot, MyContext, setupBotConversations };

// Add this new function to handle wallet deletion
async function handleDeleteWallet(
  conversation: Conversation<MyContext>,
  ctx: MyContext
) {
  try {
    if (!ctx.from?.id) {
      await ctx.reply("Error: User information not found.");
      return;
    }

    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from.id.toString(),
    });

    if (!userSettings || userSettings.wallets.length === 0) {
      await ctx.reply("You don't have any wallets to delete.", {
        reply_markup: new InlineKeyboard().text(" Back", "wallets"),
      });
      return;
    }

    // Create wallet selection keyboard
    const keyboard = new InlineKeyboard();
    userSettings.wallets.forEach((wallet, index) => {
      const isDefault =
        wallet.address === userSettings.tradingPreferences.defaultWallet;
      keyboard
        .text(
          `${wallet.name}${isDefault ? " (Default)" : ""}`,
          `select_delete_wallet_${index}`
        )
        .row();
    });
    keyboard.text("❌ Cancel", "wallets");

    await ctx.reply(
      "⚠️ Select a wallet to delete. This action cannot be undone!",
      { reply_markup: keyboard }
    );
  } catch (error) {
    console.error("Error in handleDeleteWallet:", error);
    await ctx.reply("⚠️ An error occurred while processing your request.", {
      reply_markup: new InlineKeyboard().text(" Back", "wallets"),
    });
  }
}

// Add this function to confirm wallet deletion
async function confirmWalletDeletion(ctx: MyContext, walletIndex: number) {
  try {
    if (!ctx.from?.id) {
      await ctx.reply("Error: User information not found.");
      return;
    }

    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from.id.toString(),
    });

    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.reply("Wallet not found.", {
        reply_markup: new InlineKeyboard().text(" Back", "wallets"),
      });
      return;
    }

    const wallet = userSettings.wallets[walletIndex];
    const isDefault = wallet.address === userSettings.tradingPreferences.defaultWallet;

    // Show confirmation message with wallet details
    await ctx.reply(
      `⚠️ You are about to delete the following wallet:\n\n` +
      `Name: ${wallet.name}\n` +
      `Address: ${wallet.address}\n` +
      `Status: ${isDefault ? "Default Wallet" : "Regular Wallet"}\n\n` +
      `Are you sure you want to proceed?`,
      {
        reply_markup: new InlineKeyboard()
          .text("✅ Yes, show private key", `confirm_delete_wallet_${walletIndex}`)
          .row()
          .text("❌ No, cancel", "wallets"),
      }
    );
  } catch (error) {
    console.error("Error in confirmWalletDeletion:", error);
    await ctx.reply("⚠️ An error occurred while processing your request.", {
      reply_markup: new InlineKeyboard().text(" Back", "wallets"),
    });
  }
}

// Add this function to show private key and delete wallet
async function showPrivateKeyAndDeleteWallet(ctx: MyContext, walletIndex: number) {
  try {
    if (!ctx.from?.id) {
      await ctx.reply("Error: User information not found.");
      return;
    }

    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from.id.toString(),
    });

    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.reply("Wallet not found.", {
        reply_markup: new InlineKeyboard().text(" Back", "wallets"),
      });
      return;
    }

    const wallet = userSettings.wallets[walletIndex];
    const isDefault = wallet.address === userSettings.tradingPreferences.defaultWallet;
    
    // Decrypt private key
    let privateKey;
    try {
      privateKey = await decryptPrivateKey(
        wallet.encrypted,
        wallet.iv,
        wallet.tag
      );
    } catch (error) {
      console.error("Error decrypting private key:", error);
      await ctx.reply(
        "⚠️ Failed to decrypt wallet private key. Deletion cancelled."
      );
      return;
    }
    
    // Show private key with caution message
    await ctx.reply(
      `🔑 *PRIVATE KEY BACKUP* 🔑\n\n` +
      `Before deleting your wallet, please save your private key:\n\n` +
      `\`${privateKey}\`\n\n` +
      `⚠️ *IMPORTANT WARNING* ⚠️\n` +
      `• This is your ONLY chance to save this private key\n` +
      `• Anyone with this key has FULL ACCESS to your funds\n` +
      `• Store it securely and NEVER share it\n\n` +
      `Once you confirm deletion, this wallet will be permanently removed from the bot.`,
      { 
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel Deletion", `wallet_details_${walletIndex}`)
          .row()
          .text("🗑️ Permanently Delete Wallet", `delete_wallet_${walletIndex}`),
        parse_mode: "Markdown"
      }
    );
  } catch (error) {
    console.error("Error in showPrivateKeyAndDeleteWallet:", error);
    await ctx.reply("⚠️ An error occurred while deleting the wallet.", {
      reply_markup: new InlineKeyboard().text(" Back", "wallets"),
    });
  }
}

// The duplicate callback_query:data handler has been removed and consolidated with the main handler at line ~814

// Add the missing handleWalletDeletion function
async function handleWalletDeletion(ctx: MyContext, walletIndex: number) {
  try {
    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from?.id.toString(),
    });
    
    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.answerCallbackQuery("Wallet not found");
      return;
    }
    
    const wallet = userSettings.wallets[walletIndex];
    const isDefault = wallet.address === userSettings.tradingPreferences.defaultWallet;
    
    // Create confirmation keyboard
    const confirmKeyboard = new InlineKeyboard()
      .text("❌ No, Keep Wallet", `wallet_details_${walletIndex}`)
      .row()
      .text("⚠️ Yes, Delete Wallet", `confirm_delete_wallet_${walletIndex}`);
    
    await ctx.editMessageText(
      `🗑️ *Delete Wallet Confirmation* 🗑️\n\n` +
      `You are about to delete the wallet:\n\n` +
      `*Name:* ${wallet.name}\n` +
      `*Address:* \`${wallet.address}\`\n` +
      `${isDefault ? "*This is your default wallet*" : ""}\n\n` +
      `⚠️ *WARNING:* This action cannot be undone. If you proceed, you will need to back up your private key before final deletion.`,
      { 
        reply_markup: confirmKeyboard,
        parse_mode: "Markdown"
      }
    );
  } catch (error) {
    console.error("Error in handleWalletDeletion:", error);
    await ctx.answerCallbackQuery("Error processing wallet deletion");
  }
}

bot.callbackQuery(/^select_delete_wallet_(\d+)$/, async (ctx) => {
  console.log("Direct handler for select_delete_wallet_ called");
  try {
    const walletIndex = parseInt(ctx.match[1]);
    await handleWalletDeletion(ctx, walletIndex);
  } catch (error) {
    console.error("Error in select_delete_wallet_ handler:", error);
    await ctx.answerCallbackQuery("⚠️ Error processing wallet deletion request");
  }
});

bot.callbackQuery(/^wallet_details_(\d+)$/, async (ctx) => {
  console.log("Direct handler for wallet_details_ called");
  try {
    const walletIndex = parseInt(ctx.match[1]);
    await handleWalletDetails(ctx, walletIndex);
  } catch (error) {
    console.error("Error in wallet_details_ handler:", error);
    await ctx.answerCallbackQuery("⚠️ Error displaying wallet details");
  }
});

bot.callbackQuery(/^show_private_key_(\d+)$/, async (ctx) => {
  console.log("Direct handler for show_private_key_ called");
  try {
    const walletIndex = parseInt(ctx.match[1]);
    await handleShowPrivateKey(ctx, walletIndex);
  } catch (error) {
    console.error("Error in show_private_key_ handler:", error);
    await ctx.answerCallbackQuery("⚠️ Error displaying private key");
  }
});

bot.callbackQuery(/^set_default_wallet_(\d+)$/, async (ctx) => {
  console.log("Direct handler for set_default_wallet_ called");
  try {
    const walletIndex = parseInt(ctx.match[1]);
    await handleSetDefaultWallet(ctx, walletIndex);
  } catch (error) {
    console.error("Error in set_default_wallet_ handler:", error);
    await ctx.answerCallbackQuery("⚠️ Error setting default wallet");
  }
});

bot.callbackQuery(/^confirm_delete_wallet_(\d+)$/, async (ctx) => {
  console.log("Direct handler for confirm_delete_wallet_ called");
  try {
    const walletIndex = parseInt(ctx.match[1]);
    await showPrivateKeyAndDeleteWallet(ctx, walletIndex);
  } catch (error) {
    console.error("Error in confirm_delete_wallet_ handler:", error);
    await ctx.answerCallbackQuery("⚠️ Error processing wallet deletion confirmation");
  }
});

bot.callbackQuery(/^delete_wallet_(\d+)$/, async (ctx) => {
  console.log("Direct handler for delete_wallet_ called");
  try {
    const walletIndex = parseInt(ctx.match[1]);
    await finalizeWalletDeletion(ctx, walletIndex);
  } catch (error) {
    console.error("Error in delete_wallet_ handler:", error);
    await ctx.answerCallbackQuery("⚠️ Error deleting wallet");
  }
});

// Function to finalize wallet deletion
async function finalizeWalletDeletion(ctx: MyContext, walletIndex: number) {
  try {
    if (!ctx.from?.id) {
      await ctx.reply("Error: User information not found.");
      return;
    }

    // Get user settings
    const userSettings = await UserSettings.findOne({
      userId: ctx.from.id.toString(),
    });

    if (!userSettings || !userSettings.wallets[walletIndex]) {
      await ctx.reply("Wallet not found.", {
        reply_markup: new InlineKeyboard().text("🔙 Back", "wallets"),
      });
      return;
    }

    const wallet = userSettings.wallets[walletIndex];
    const isDefault = wallet.address === userSettings.tradingPreferences.defaultWallet;
    
    // If this is the default wallet, clear the default wallet setting
    if (isDefault) {
      userSettings.tradingPreferences.defaultWallet = "";
    }
    
    // Remove the wallet from the array
    userSettings.wallets.splice(walletIndex, 1);
    
    // Save the updated user settings
    await userSettings.save();
    
    // Confirm deletion to user
    await ctx.reply(
      `✅ Wallet "${wallet.name}" has been permanently deleted.\n\n` +
      `${isDefault ? "This was your default wallet. Please set a new default wallet." : ""}`,
      {
        reply_markup: new InlineKeyboard().text("👛 Manage Wallets", "wallets"),
        parse_mode: "Markdown"
      }
    );
  } catch (error) {
    console.error("Error in finalizeWalletDeletion:", error);
    await ctx.reply("⚠️ An error occurred while deleting the wallet.", {
      reply_markup: new InlineKeyboard().text("🔙 Back", "wallets"),
    });
  }
}
