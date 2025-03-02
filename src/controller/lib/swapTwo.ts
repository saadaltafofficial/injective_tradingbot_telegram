import { MsgExecuteContract, MsgBroadcasterWithPk } from '@injectivelabs/sdk-ts';
import { ChainId } from '@injectivelabs/ts-types';
import { getNetworkEndpoints, Network } from '@injectivelabs/networks';


const executeSwap = async () => {
    
const injectiveAddress = "inj1z7ztkq4rjtur2xs8lvclhkl54ug8qcas76afmy";  
const contractAddress = "inj1r8lc3dfxqxs65rkng70ngvgdr8myvu9y7q2pru";
const privateKey = "0x7de5b6ddae89216aea9d73567b295994a32e9b729211b99ce30539eb4be32dd2";

const tokenDecimals: Record<string, number> = {
    'inj': 18,
    'peggy0xb2617246d0c6c0087f18703d576831899ca94f01': 18,
  };

const tenZIG = "10000000000000000000";
console.log("✅ Sending Amount:", tenZIG); 

const msg = MsgExecuteContract.fromJSON({
  contractAddress,
  sender: injectiveAddress,
  msg: {
    swap_min_output: {
        target_denom: "inj",
        min_output_quantity: "68730000000000000" 
      }
    },
    funds: [
      {
        denom: "peggy0xb2617246d0c6c0087f18703d576831899ca94f01",
        amount: tenZIG 
      }
    ]
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

// executeSwap();