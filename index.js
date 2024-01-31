import MerkleDistributor from '@jup-ag/merkle-distributor-sdk';
import { Keypair, Connection, Transaction, PublicKey, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } from '@solana/spl-token';

import fetch from 'node-fetch'
import * as bs58 from 'bs58';
import axios from 'axios';

const jupTokenAddress = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");

/*
!!!!!!!!!!!!! please pay attention to the variables below
*/

// wallet where there are the alloc JUP
const privateKeyFromCompWallet = [
  "abc2...", // comp wallet private key #1 (as a string)
  "abc3...", // comp wallet private key #2 (as a string)
];

// the wallet that is NOT compromised, and will receive the airdrop (hopefully) at the end
// please pay attention, you have to have a least 0.07 sol * number of compromised wallets above in balance
const privateKeyWalletNotComp = "abc1..."  

const rpcAddress = 'https://mainnet.helius-rpc.com/?api-key=....';

// apparently 10000 double the fees (from 0.00001 to 0.00002)
const PRIORITY_RATE = 10000;

/*
!!!!!!!!!!!!! end of variables
*/


// Wallet who pay the fees and get back alloc JUP
const privateKeyWallet = bs58.default.decode(privateKeyWalletNotComp);
const wallet = Keypair.fromSecretKey(privateKeyWallet);
console.log("the wallet address that will receive the JUP tokens is : "+wallet.publicKey.toString());

// Initialize connection and wallet
const connection = new Connection(rpcAddress);

async function getAssociatedTokenAccount(mint, owner) {

  const tokenAccount = await getAssociatedTokenAddress(
    mint,
    owner,  // to
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  return tokenAccount;
}

async function createAssociatedTokenAccount(payer, associatedTokenAccount, owner) {

  const createAtaInstruction = createAssociatedTokenAccountInstruction(
    payer, // payer
    associatedTokenAccount, // destination
    owner, // owner of destination
    jupTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  )

  return createAtaInstruction;
}

async function getAllocFrom(publicKey, merkleDistributor) {
  try {
    const alloc = await merkleDistributor.getUser(publicKey);
    
    if(!alloc) {
      
      console.log("no alloc for "+publicKey.toString()+" ?", alloc);
      return;
    }

    return alloc;

  } catch(err) {
    console.log('error while fetching alloc : ', err);

    throw err;
  }
}

async function main() {
  
    const currentSlot = await connection.getSlot();
    
    if(currentSlot < 245286497) {
      
      console.log('currentSlot is '+currentSlot);
      console.log('start slot is 245286497');
      
      var remaingingSlots = 245286497 - currentSlot;
      
      console.log('Remaining slots : '+remaingingSlots);
      
      let ms = 0;
      
      if(remaingingSlots > 1000)
        ms = 3000;
      else if(remaingingSlots > 500)
        ms = 1000;
      else if(remaingingSlots > 50)
        ms = 500;
      
      console.log('We try again in '+ms+' ms');
      
      setTimeout(main, ms);
      
      return;
    }
    
    
    for(let privateKey of privateKeyFromCompWallet) {
      
      try {
        
      
        const compKeypair = Keypair.fromSecretKey(bs58.default.decode(privateKey));
        const compWallet = new Wallet(compKeypair);
        
        const provider = new AnchorProvider(connection, compWallet, {
          commitment: 'confirmed',
        });
        
        const MerkleDistributorClass = MerkleDistributor.default;

        // Initialize MerkleDistributor
        const merkleDistributor = new MerkleDistributorClass(provider, {
          targetToken: jupTokenAddress,
          claimProofEndpoint: 'https://worker.jup.ag/jup-claim-proof',
        });
        
        merkleDistributor.getUser = async function(wallet) {
          
          const json = await axios.get('https://worker.jup.ag/jup-claim-proof/'+jupTokenAddress.toString()+'/'+wallet.toString())
          
          return json.data;
        }
        
        console.log("trying to claim for this wallet : "+compKeypair.publicKey.toString())
        
        // Check if user has allocations
        const alloc = await getAllocFrom(compKeypair.publicKey, merkleDistributor);

        if (!alloc || alloc.amount === 0) {
          console.log('No Alloc ! You fucked up, bozo !!')
          console.log('alloc', alloc)
          continue;
        };
        
        console.log("the alloc is "+alloc.amount / 1000000)

        // Create tx
        let tx = new Transaction();

        // Add instructions for sending sol to allocWallet
        // from walletFromMe vers walletFromSon
        tx.add(SystemProgram.transfer({
          // Account that will send transferred lamports
          fromPubkey: wallet.publicKey,
          // Account that will receive transferred lamports
          toPubkey: compKeypair.publicKey,
          // Minimum amount of lamports to transfer for recover all fees
          lamports: LAMPORTS_PER_SOL * 0.07,
        }));

        // Get ATA from allocWallet and $JUP (created by Jupiter)
        let associatedJupCompTokenAccount = await getAssociatedTokenAccount(jupTokenAddress, compKeypair.publicKey);

        // Get claim instructions
        const ixs = (await merkleDistributor.claimToken(compKeypair.publicKey)) || [];

        if (ixs.length === 0) {
          console.error('No instructions to claim.');
          continue;
        }

        // Add Merkle Instructions at the tx
        tx.add(...ixs);

        // Create ATA for wallet who get back $JUP
        let associatedJupTokenAccountWallet = await getAssociatedTokenAccount(jupTokenAddress, wallet.publicKey);

        // Check if account already exist, if not (null), create it and add it to the transaction
        const dataTmp2 = await connection.getAccountInfo(associatedJupTokenAccountWallet);

        if (dataTmp2 === null) {

          const createAtaInstructionSecours = await createAssociatedTokenAccount(wallet.publicKey, associatedJupTokenAccountWallet, wallet.publicKey);

          tx.add(createAtaInstructionSecours);
        }

        // Add $JUP transfert instruction to transaction
        tx.add(createTransferInstruction(
          associatedJupCompTokenAccount, // source
          associatedJupTokenAccountWallet, // destination
          wallet.publicKey, // payer
          alloc.amount * 1000
        ));

        // add priority fees
        const priority_fees_ix = ComputeBudgetProgram.setComputeUnitPrice({microLamports: PRIORITY_RATE});
        
        tx.add(priority_fees_ix);

        const blockHash = (await connection.getLatestBlockhash('finalized')).blockhash;
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = blockHash;
        
        tx.sign(wallet, compKeypair)
        
        const txnSignature = await connection.sendRawTransaction(
          tx.serialize(),
          // leave the flag at false to avoid sending the tx if an error occurs
          // Actually, Jupiter returns a ClaimingIsNotStarted error, which make sense ;)
          { skipPreflight: false }
        );

        console.log("Signature : " + txnSignature);

        // Tx failed, re run
        if (!txnSignature) {
          console.log('FAILED !!! please try to run it again');
        }
        
        console.log("Transaction was sent, go check on solscan if it succeeded : "+txnSignature)

      } catch (error) {
        console.log(error);
      }
      
  }

}

main();
