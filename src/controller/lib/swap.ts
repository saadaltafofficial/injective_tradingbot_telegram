import {
  MsgExecuteContract,
  MsgBroadcasterWithPk,
} from "@injectivelabs/sdk-ts";
import { ChainId } from "@injectivelabs/ts-types";
import { getNetworkEndpoints, Network } from "@injectivelabs/networks";
import { getMarketDetails } from "./injective";
import { BigNumberInBase } from "@injectivelabs/utils";
import { getSpotMarketData } from "./placeSpotOrder";

const executeSwap = async (
  minOutputQuantity: number,
  targetDenom: string,
  fundsDenom: string,
  fundsAmount?: string
) => {
  const injectiveAddress = "inj1z7ztkq4rjtur2xs8lvclhkl54ug8qcas76afmy";
  const contractAddress = "inj1r8lc3dfxqxs65rkng70ngvgdr8myvu9y7q2pru";
  const privateKey =
    "0x7de5b6ddae89216aea9d73567b295994a32e9b729211b99ce30539eb4be32dd2";

  const marketDetails = await getMarketDetails(
    "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7"
  );
  console.log(marketDetails);

  console.log("Sending Amount: order");

  const minimumFundsQuantity = marketDetails?.highPrice;
  const minOutputQuantityInBaseUnits = new BigNumberInBase(minOutputQuantity)
    .toWei(marketDetails?.baseDecimals)
    .toFixed();
  const fundsAmountInBaseUnits = new BigNumberInBase(minimumFundsQuantity!)
    .toWei(marketDetails?.quoteDecimals)
    .toFixed();
  console.log("Targeted Denom: ", targetDenom);
  console.log("Funds Denom: ", fundsDenom);
  console.log("Minimum Output Quantity: ", minOutputQuantityInBaseUnits);
  console.log("Funds Amount: ", fundsAmountInBaseUnits);

  const msg = MsgExecuteContract.fromJSON({
    contractAddress,
    sender: injectiveAddress,
    msg: {
      swap_min_output: {
        target_denom: targetDenom,
        min_output_quantity: "10000000000000000000",
      },
    },
    funds: [
      {
        denom: fundsDenom,
        amount: "78762000000000000",
      },
    ],
  });

  const broadcaster = new MsgBroadcasterWithPk({
    privateKey,
    network: Network.Mainnet,
  });

  try {
    const txHash = await broadcaster.broadcast({
      msgs: msg,
    });
    console.log("Transaction Successful! Hash:", txHash);
  } catch (error) {
    console.error("Swap Error:", error);
  }
};


// executeSwap(10, "peggy0xb2617246d0c6c0087f18703d576831899ca94f01", "inj");
