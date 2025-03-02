# Injective Telegram Trading Bot

A powerful Telegram bot for trading on the Injective Chain directly from Telegram. This bot allows users to manage wallets, check portfolio balances, and execute trades on Injective DEX.

## Features

- 💹 **Trade**: Execute spot trades on Injective DEX
- 👛 **Wallet Management**: Create, import, rename, and delete wallets
- 📊 **Portfolio**: View your portfolio balances and track your assets

## Commands

### Main Menu

The bot provides three main commands in a single row:

- **💹 Trade**: Access trading functionality
- **👛 Wallets**: Manage your wallets
- **📊 Portfolio**: View your portfolio and balances

### Trading Commands

- **💰 Buy**: Place a buy order for a specific market
- **💸 Sell**: Place a sell order for a specific market
- **🔍 Market Search**: Search for available markets to trade
- **📈 Market Info**: View detailed information about a specific market

### Wallet Management

- **👛 Create Wallet**: Create a new wallet
- **🔑 Import Wallet**: Import an existing wallet using a private key
- **✏️ Rename Wallet**: Change the name of an existing wallet
- **🗑️ Delete Wallet**: Remove a wallet from the bot
- **🔐 Show Private Key**: Display the private key for a wallet (use with caution)
- **📋 Wallet Details**: View wallet address and balances

### Portfolio Commands

- **📊 View Portfolio**: See all your assets across wallets
- **💰 Check Balance**: View the balance of a specific token

## Installation

1. Clone the repository
```bash
git clone https://github.com/yourusername/injective-telegram-trading-bot.git
cd injective-telegram-trading-bot
```

2. Install dependencies
```bash
npm install
# or
pnpm install
```

3. Create a `.env` file based on `.env.example`
```bash
cp .env.example .env
```

4. Fill in your environment variables in the `.env` file

5. Build the project
```bash
npm run build
# or
pnpm run build
```

6. Start the bot
```bash
npm run start
# or
pnpm run start
```

## Environment Variables

See `.env.example` for the required environment variables.

## Project Structure

```
injective-telegram-trading-bot/
├─ .env                    # Environment variables
├─ dist/                   # Compiled JavaScript files
├─ src/                    # Source TypeScript files
│  ├─ controller/          # Controller logic
│  │  └─ lib/              # Library functions
│  │     ├─ axios.ts       # Axios configuration
│  │     ├─ injective.ts   # Injective Chain interactions
│  │     ├─ placeSpotOrder.ts # Order placement logic
│  │     ├─ pools.ts       # Liquidity pool functions
│  │     ├─ spotmarket.ts  # Spot market functions
│  │     ├─ swap.ts        # Token swap functions
│  │     └─ Telegram.ts    # Telegram bot logic
│  ├─ db.ts                # Database connection
│  └─ index.ts             # Entry point
├─ tsconfig.json           # TypeScript configuration
├─ package.json            # Project dependencies
└─ README.md               # Project documentation
```

## Dependencies

- Telegram Bot SDK (Telegraf)
- MongoDB for data storage
- Injective Chain SDK
- Ethers.js for cryptographic operations

## License

[MIT](LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.