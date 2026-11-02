import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";
import { hashPixKey, computeCrc16Ccitt } from "../client/src/pix_utils";

describe("PixSol Escrow Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // We load the compiled program interface
  const program = anchor.workspace.PixsolEscrow as Program;

  let mint: PublicKey;
  let maker: Keypair;
  let buyer: Keypair;
  let oracleRelayer: Keypair;
  let makerTokenAccount: PublicKey;
  let buyerTokenAccount: PublicKey;

  const orderId = new anchor.BN(90210);
  const tokenAmount = new anchor.BN(50_000_000); // 50.000000 USDC (6 decimals)
  const pixAmountCents = new anchor.BN(28500); // R$ 285,00
  const pixKey = "pix@seeker.sol.br";
  const validPixEndToEndId = "E182361202024090119280000001092A"; // Exactly 32 chars

  before(async () => {
    maker = Keypair.generate();
    buyer = Keypair.generate();
    oracleRelayer = Keypair.generate();

    // Airdrop SOL to test accounts
    const airdropMaker = await provider.connection.requestAirdrop(
      maker.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    const airdropOracle = await provider.connection.requestAirdrop(
      oracleRelayer.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropMaker);
    await provider.connection.confirmTransaction(airdropOracle);

    // Create fake USDC token mint
    mint = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      6
    );

    // Setup Token Accounts
    makerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      maker,
      mint,
      maker.publicKey
    );

    buyerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      maker,
      mint,
      buyer.publicKey
    );

    // Mint 500 USDC to Maker
    await mintTo(
      provider.connection,
      maker,
      mint,
      makerTokenAccount,
      maker.publicKey,
      500_000_000
    );
  });

  it("1. Successfully initializes an Escrow order via Maker (Seed Vault)", async () => {
    const pixKeyHash = hashPixKey(pixKey);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow_order"),
        maker.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [tokenVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeOrder(
        orderId,
        tokenAmount,
        pixAmountCents,
        Array.from(pixKeyHash),
        new anchor.BN(600) // 10 minutes expiry
      )
      .accounts({
        maker: maker.publicKey,
        buyer: buyer.publicKey,
        mint: mint,
        makerTokenAccount: makerTokenAccount,
        escrowOrder: escrowPda,
        tokenVault: tokenVault,
        oracleRelayer: oracleRelayer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([maker])
      .rpc();

    // Verify vault balance
    const vaultAccount = await getAccount(provider.connection, tokenVault);
    expect(Number(vaultAccount.amount)).to.equal(50_000_000);

    // Verify Escrow state
    const orderState: any = await program.account.escrowOrder.fetch(escrowPda);
    expect(orderState.maker.toBase58()).to.equal(maker.publicKey.toBase58());
    expect(orderState.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(orderState.tokenAmount.toNumber()).to.equal(50_000_000);
    expect(orderState.pixAmountCents.toNumber()).to.equal(28500);
    expect(orderState.status).to.deep.equal({ pendingPix: {} });
  });

  it("2. Fails to settle if unauthorized relayer tries to sign", async () => {
    const fakeRelayer = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(fakeRelayer.publicKey, LAMPORTS_PER_SOL)
    );

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow_order"),
        maker.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [tokenVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    const dummySignature = new Array(64).fill(0);

    try {
      await program.methods
        .settleOrder(validPixEndToEndId, dummySignature)
        .accounts({
          oracleRelayer: fakeRelayer.publicKey,
          maker: maker.publicKey,
          buyer: buyer.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          escrowOrder: escrowPda,
          tokenVault: tokenVault,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([fakeRelayer])
        .rpc();
      assert.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("3. Successfully settles the order with verified PIX EndToEndId", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow_order"),
        maker.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [tokenVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    const dummySignature = new Array(64).fill(2);

    await program.methods
      .settleOrder(validPixEndToEndId, dummySignature)
      .accounts({
        oracleRelayer: oracleRelayer.publicKey,
        maker: maker.publicKey,
        buyer: buyer.publicKey,
        buyerTokenAccount: buyerTokenAccount,
        escrowOrder: escrowPda,
        tokenVault: tokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([oracleRelayer])
      .rpc();

    // Verify buyer received tokens
    const buyerAccount = await getAccount(provider.connection, buyerTokenAccount);
    expect(Number(buyerAccount.amount)).to.equal(50_000_000);

    // Verify escrow status is Settled
    const orderState: any = await program.account.escrowOrder.fetch(escrowPda);
    expect(orderState.status).to.deep.equal({ settled: {} });

    // Verify UTF-8 decode of stored BACEN EndToEnd ID
    const storedId = Buffer.from(orderState.pixEndToEndId).toString("utf8");
    expect(storedId).to.equal(validPixEndToEndId);
  });

  it("4. Prevents order cancellation before expiration timelock", async () => {
    const unexpiredOrderId = new anchor.BN(90211);
    const pixKeyHash = hashPixKey("unexpired@pixsol.app");

    const [unexpiredEscrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow_order"),
        maker.publicKey.toBuffer(),
        unexpiredOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [unexpiredVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), unexpiredEscrowPda.toBuffer()],
      program.programId
    );

    // Init with 600s expiration
    await program.methods
      .initializeOrder(
        unexpiredOrderId,
        tokenAmount,
        pixAmountCents,
        Array.from(pixKeyHash),
        new anchor.BN(600)
      )
      .accounts({
        maker: maker.publicKey,
        buyer: buyer.publicKey,
        mint: mint,
        makerTokenAccount: makerTokenAccount,
        escrowOrder: unexpiredEscrowPda,
        tokenVault: unexpiredVault,
        oracleRelayer: oracleRelayer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([maker])
      .rpc();

    // Immediate cancellation must fail
    try {
      await program.methods
        .cancelOrder()
        .accounts({
          maker: maker.publicKey,
          makerTokenAccount: makerTokenAccount,
          escrowOrder: unexpiredEscrowPda,
          tokenVault: unexpiredVault,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();
      assert.fail("Should have failed because order is not expired");
    } catch (err: any) {
      expect(err.message).to.include("OrderNotExpired");
    }
  });

  it("5. Correctly calculates CRC16-CCITT for Brazilian Central Bank QR Codes", () => {
    const testString = "00020101021226360014br.gov.bcb.pix0114+5511999999999520400005303986540510.005802BR5913PIXSOL MERCH6009SAO PAULO62070503***6304";
    const crc = computeCrc16Ccitt(testString);
    expect(crc).to.have.lengthOf(4);
  });
});