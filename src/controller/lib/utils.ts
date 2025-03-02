import * as crypto from 'crypto';
import dotenv from 'dotenv'
import { getMarketDetails } from './injective';
import { IndexerGrpcSpotApi } from '@injectivelabs/sdk-ts';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';


const endpoints = getNetworkEndpoints(Network.Mainnet);
const indexerGrpcSpotApi = new IndexerGrpcSpotApi(endpoints.indexer);

dotenv.config()
const algorithm = 'aes-256-gcm';

// Generate a proper 32-byte key (use a secure key in production)
const encryptionKey = crypto.createHash('sha256').update(`${process.env.ENCRYPTION_KEY}`).digest();

// Encrypt Function
function encryptPrivateKey(privateKey: string): { encrypted: string; iv: string; tag: string } { 

        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(algorithm, encryptionKey, iv);
    
        let encrypted = cipher.update(privateKey, 'utf-8', 'hex');
        encrypted += cipher.final('hex');
    
        const authTag = cipher.getAuthTag().toString('hex'); 
    
        return { encrypted, iv: iv.toString('hex'), tag: authTag };
        
}

// Decrypt Function
function decryptPrivateKey(encryptedData: string, ivHex: string, authTagHex: string): string {
    try {

        const decipher = crypto.createDecipheriv(algorithm, encryptionKey, Buffer.from(ivHex, 'hex'));
    
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex')); 
    
        let decrypted = decipher.update(encryptedData, 'hex', 'utf-8');
        decrypted += decipher.final('utf-8');
    
        return decrypted;
        
    } catch (error) {        
        console.log("Error in Decrypting key",error)
        return `Error in Decrypting key`
    }
}

async function getMinimumOrderAmount(ticker: string) {
    try {
        // 1️⃣ Fetch market details
        const marketDetails = await getMarketDetails(ticker);
        const minTickSize = marketDetails.minQuantityTickSize;
        const minPriceTickSize = marketDetails.minPriceTickSize;
        const baseToken = marketDetails.baseSymbol
        const quoteToken = marketDetails.quoteSymbol

        console.log(`Market: ${baseToken}/${quoteToken}`);
        console.log(`Min Tick Size: ${minTickSize}`);
        console.log(`Min Price Tick Size: ${minPriceTickSize}`);

        // 2️⃣ Fetch market order book

        const orderBook = await indexerGrpcSpotApi.fetchOrderbookV2(
            `${marketDetails?.marketId}`
          );

        const bestAskPrice = orderBook.buys.length > 0 ? parseFloat(orderBook.buys[0].price) : 0;
        const bestBidPrice = orderBook.sells.length > 0 ? parseFloat(orderBook.sells[0].price) : 0;

        console.log(`Best Ask Price: ${bestAskPrice}, Best Bid Price: ${bestBidPrice}`);

        // 3️⃣ Calculate Minimum Order Amount
        const minOrderAmountToBuy = minTickSize * bestAskPrice;
        const minOrderAmountToSell = minTickSize * bestBidPrice;

        return {
            market: `${baseToken}/${quoteToken}`,
            minTickSize,
            minPriceTickSize,
            bestAskPrice,
            bestBidPrice,
            minOrderAmountToBuy,
            minOrderAmountToSell
        };
    } catch (error) {
        console.error("Error fetching market details:", error);
        return null;
    }
}



export { encryptPrivateKey, decryptPrivateKey, getMinimumOrderAmount }