import { ethers } from "ethers";

export class SecurityUtils {
  static validateAddress(address: string): boolean {
    try {
      return ethers.utils.isAddress(address);
    } catch {
      return false;
    }
  }

  static sanitizeInput(input: string): string {
    // Remove any potential HTML/script tags
    input = input.replace(/<[^>]*>?/gm, "");
    // Remove special characters except common symbols
    return input.replace(/[^\w\s-_.@]/gi, "");
  }

  static validateWalletName(name: string): boolean {
    // Check length and allowed characters
    const validNameRegex = /^[a-zA-Z0-9_-]{3,30}$/;
    return validNameRegex.test(name);
  }

  static validateAmount(amount: string): boolean {
    // Check if amount is a valid number and within reasonable range
    const num = parseFloat(amount);
    return !isNaN(num) && num > 0 && num < 1000000000;
  }

  static validatePrivateKey(privateKey: string): boolean {
    try {
      // Check if it's a valid private key format
      return privateKey.length === 64 && /^[0-9a-fA-F]{64}$/.test(privateKey);
    } catch {
      return false;
    }
  }

  static isValidTicker(ticker: string): boolean {
    // Basic validation for token tickers
    const validTickerRegex = /^[A-Z0-9/]{2,10}$/;
    return validTickerRegex.test(ticker.toUpperCase());
  }
}
