import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PixflowSeeker } from "../target/types/pixflow_seeker";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pixflow-seeker tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PixflowSeeker as Program<PixflowSeeker>;

  let mint: anchor.web3.PublicKey;
  let buyerTokenAccount: anchor.web3.PublicKey;
  let sellerTokenAccount: anchor.web3.PublicKey;

  const buyer = anchor.web3.Keypair.generate();
  const seller = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();
  const intruder = anchor.web3.Keypair.generate();

  const orderId = new anchor.BN("9876543210123456789");
  const tokenAmount = new anchor.BN(50_000_000); // 50 USDC (6 decimals)
  const brlAmountCents = new anchor.BN(28550);   // R$ 285.50
  const timeoutSeconds = new anchor.BN(2);        // 2 seconds timeout for fast test

  let orderStatePDA: anchor.web3.PublicKey;
  let vaultPDA: anchor.web3.PublicKey;
  let vaultAuthPDA: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [buyer, seller, oracle, intruder]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create mock USDC mint
    mint = await createMint(
      provider.connection,
      buyer,
      buyer.publicKey,
      null,
      6
    );

    // Create token accounts
    buyerTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );

    sellerTokenAccount = await createAccount(
      provider.connection,
      seller,
      mint,
      seller.publicKey
    );

    // Mint 100 USDC to Buyer
    await mintTo(
      provider.connection,
      buyer,
      mint,
      buyerTokenAccount,
      buyer.publicKey,
      100_000_000
    );

    // Derive PDAs
    const orderIdBytes = orderId.toArrayLike(Buffer, "le", 16);
    [orderStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderIdBytes],
      program.programId
    );

    [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), orderStatePDA.toBuffer()],
      program.programId
    );

    [vaultAuthPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), orderStatePDA.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully creates an escrow order on Seeker", async () => {
    await program.methods
      .createOrder(orderId, tokenAmount, brlAmountCents, timeoutSeconds)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        mint: mint,
        buyerTokenAccount: buyerTokenAccount,
        orderState: orderStatePDA,
        vault: vaultPDA,
        vaultAuthority: vaultAuthPDA,
        oracleAuthority: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    const orderAccount = await program.account.orderState.fetch(orderStatePDA);
    expect(orderAccount.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(orderAccount.seller.toBase58()).to.equal(seller.publicKey.toBase58());
    expect(orderAccount.tokenAmount.toNumber()).to.equal(tokenAmount.toNumber());
    expect(orderAccount.brlAmountCents.toNumber()).to.equal(brlAmountCents.toNumber());

    const vaultInfo = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultInfo.amount)).to.equal(50_000_000);
  });

  it("2. Fails when unauthorized caller attempts to complete order", async () => {
    const fakeE2EId = Array.from(Buffer.alloc(32, 1));
    try {
      await program.methods
        .completeOrder(fakeE2EId)
        .accounts({
          oracleSigner: intruder.publicKey, // Intruder is not the authorized oracle
          orderState: orderStatePDA,
          seller: seller.publicKey,
          sellerTokenAccount: sellerTokenAccount,
          vault: vaultPDA,
          vaultAuthority: vaultAuthPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([intruder])
        .rpc();
      expect.fail("Should have thrown UnauthorizedAuthority");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAuthority");
    }
  });

  it("3. Successfully completes order with authorized PIX Oracle signature", async () => {
    // E12345678202409251200000000000000 (Central Bank PIX E2E ID)
    const e2eBuffer = Buffer.alloc(32);
    e2eBuffer.write("E00038166202409251200AABBCCDDEEFF");
    const e2eArray = Array.from(e2eBuffer);

    await program.methods
      .completeOrder(e2eArray)
      .accounts({
        oracleSigner: oracle.publicKey,
        orderState: orderStatePDA,
        seller: seller.publicKey,
        sellerTokenAccount: sellerTokenAccount,
        vault: vaultPDA,
        vaultAuthority: vaultAuthPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([oracle])
      .rpc();

    const orderAccount = await program.account.orderState.fetch(orderStatePDA);
    expect(orderAccount.status).to.deep.equal({ settled: {} });

    // Verify merchant received funds
    const sellerInfo = await getAccount(provider.connection, sellerTokenAccount);
    expect(Number(sellerInfo.amount)).to.equal(50_000_000);
  });

  it("4. Prevents double-settlement", async () => {
    const e2eArray = Array.from(Buffer.alloc(32, 2));
    try {
      await program.methods
        .completeOrder(e2eArray)
        .accounts({
          oracleSigner: oracle.publicKey,
          orderState: orderStatePDA,
          seller: seller.publicKey,
          sellerTokenAccount: sellerTokenAccount,
          vault: vaultPDA,
          vaultAuthority: vaultAuthPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have thrown InvalidOrderState");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidOrderState");
    }
  });

  it("5. Allows buyer refund after order timeout", async () => {
    const orderId2 = new anchor.BN("112233445566778899");
    const [orderState2PDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), orderId2.toArrayLike(Buffer, "le", 16)],
      program.programId
    );
    const [vault2PDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), orderState2PDA.toBuffer()],
      program.programId
    );
    const [vaultAuth2PDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), orderState2PDA.toBuffer()],
      program.programId
    );

    // Create 1-second expiring escrow
    await program.methods
      .createOrder(orderId2, new anchor.BN(10_000_000), new anchor.BN(5700), new anchor.BN(1))
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        mint: mint,
        buyerTokenAccount: buyerTokenAccount,
        orderState: orderState2PDA,
        vault: vault2PDA,
        vaultAuthority: vaultAuth2PDA,
        oracleAuthority: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    // Wait 2.5 seconds for timeout to pass
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Refund order
    await program.methods
      .refundOrder()
      .accounts({
        buyer: buyer.publicKey,
        orderState: orderState2PDA,
        buyerTokenAccount: buyerTokenAccount,
        vault: vault2PDA,
        vaultAuthority: vaultAuth2PDA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const orderAccount2 = await program.account.orderState.fetch(orderState2PDA);
    expect(orderAccount2.status).to.deep.equal({ refunded: {} });
  });
});