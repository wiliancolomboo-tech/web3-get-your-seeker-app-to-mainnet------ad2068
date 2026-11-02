import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PixsolCore } from "../target/types/pixsol_core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

describe("pixsol_core comprehensive QA matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PixsolCore as Program<PixsolCore>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const feeRecipient = Keypair.generate();
  const trustedRelayer = Keypair.generate();
  const rogueRelayer = Keypair.generate();
  const customer = Keypair.generate();
  const merchant = Keypair.generate();

  let mint: PublicKey;
  let customerAta: PublicKey;
  let merchantAta: PublicKey;
  let feeRecipientAta: PublicKey;
  let configPda: PublicKey;

  const PROTOCOL_FEE_BPS = 200; // 2.0%
  const DEPOSIT_AMOUNT = new anchor.BN(100_000_000); // 100 USDC (6 decimals)

  before(async () => {
    // Fund test keypairs with SOL
    const airdropSigners = [feeRecipient, trustedRelayer, rogueRelayer, customer, merchant];
    for (const kp of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlock = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlock.blockhash,
        lastValidBlockHeight: latestBlock.lastValidBlockHeight,
      });
    }

    // Deploy test SPL stablecoin mint
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create ATAs
    customerAta = await createAccount(provider.connection, customer, mint, customer.publicKey);
    merchantAta = await createAccount(provider.connection, merchant, mint, merchant.publicKey);
    feeRecipientAta = await createAccount(provider.connection, feeRecipient, mint, feeRecipient.publicKey);

    // Mint 500 USDC to customer
    await mintTo(provider.connection, admin, mint, customerAta, admin.publicKey, 500_000_000);

    // Derive Config PDA
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_config")],
      program.programId
    );
  });

  it("1. Successfully initializes protocol with fee bounds", async () => {
    await program.methods
      .initializeProtocol(PROTOCOL_FEE_BPS)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        feeRecipient: feeRecipient.publicKey,
        trustedRelayer: trustedRelayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.trustedRelayer.toBase58()).to.equal(trustedRelayer.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Creates an order and locks tokens in vault PDA", async () => {
    const orderId = Array.from(crypto.randomBytes(16));
    const orderIdBuffer = Buffer.from(orderId);
    const pixExpected = Array.from(crypto.randomBytes(32));

    const [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_order"), orderIdBuffer],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_vault"), orderIdBuffer],
      program.programId
    );

    await program.methods
      .createOrder(orderId, DEPOSIT_AMOUNT, new anchor.BN(600), pixExpected)
      .accounts({
        config: configPda,
        order: orderPda,
        orderVault: vaultPda,
        mint: mint,
        customerToken: customerAta,
        customer: customer.publicKey,
        merchant: merchant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([customer])
      .rpc();

    const orderAccount = await program.account.orderState.fetch(orderPda);
    expect(orderAccount.customer.toBase58()).to.equal(customer.publicKey.toBase58());
    expect(orderAccount.merchant.toBase58()).to.equal(merchant.publicKey.toBase58());
    expect(orderAccount.amount.toNumber()).to.equal(DEPOSIT_AMOUNT.toNumber());

    const vaultTokenAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultTokenAccount.amount)).to.equal(DEPOSIT_AMOUNT.toNumber());
  });

  it("3. Rejects fulfillment if attempted by unauthorized relayer", async () => {
    const orderId = Array.from(crypto.randomBytes(16));
    const orderIdBuffer = Buffer.from(orderId);
    const pixExpected = Array.from(crypto.randomBytes(32));

    const [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_order"), orderIdBuffer],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_vault"), orderIdBuffer],
      program.programId
    );

    // Create Order
    await program.methods
      .createOrder(orderId, DEPOSIT_AMOUNT, new anchor.BN(600), pixExpected)
      .accounts({
        config: configPda,
        order: orderPda,
        orderVault: vaultPda,
        mint: mint,
        customerToken: customerAta,
        customer: customer.publicKey,
        merchant: merchant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([customer])
      .rpc();

    const receipt = Array.from(crypto.randomBytes(32));

    try {
      await program.methods
        .fulfillOrder(orderId, receipt)
        .accounts({
          config: configPda,
          order: orderPda,
          orderVault: vaultPda,
          mint: mint,
          merchantToken: merchantAta,
          feeRecipientToken: feeRecipientAta,
          merchant: merchant.publicKey,
          relayer: rogueRelayer.publicKey, // Unauthorized!
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([rogueRelayer])
        .rpc();
      expect.fail("Should have thrown UnauthorizedRelayer error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedRelayer");
    }
  });

  it("4. Successfully fulfills order via trusted relayer and splits fees", async () => {
    const orderId = Array.from(crypto.randomBytes(16));
    const orderIdBuffer = Buffer.from(orderId);
    const pixExpected = Array.from(crypto.randomBytes(32));

    const [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_order"), orderIdBuffer],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_vault"), orderIdBuffer],
      program.programId
    );

    await program.methods
      .createOrder(orderId, DEPOSIT_AMOUNT, new anchor.BN(600), pixExpected)
      .accounts({
        config: configPda,
        order: orderPda,
        orderVault: vaultPda,
        mint: mint,
        customerToken: customerAta,
        customer: customer.publicKey,
        merchant: merchant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([customer])
      .rpc();

    const merchantPreBalance = (await getAccount(provider.connection, merchantAta)).amount;
    const feePreBalance = (await getAccount(provider.connection, feeRecipientAta)).amount;

    const receipt = Array.from(crypto.randomBytes(32));

    await program.methods
      .fulfillOrder(orderId, receipt)
      .accounts({
        config: configPda,
        order: orderPda,
        orderVault: vaultPda,
        mint: mint,
        merchantToken: merchantAta,
        feeRecipientToken: feeRecipientAta,
        merchant: merchant.publicKey,
        relayer: trustedRelayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trustedRelayer])
      .rpc();

    const merchantPostBalance = (await getAccount(provider.connection, merchantAta)).amount;
    const feePostBalance = (await getAccount(provider.connection, feeRecipientAta)).amount;

    // Expected fee: 2% of 100 USDC = 2 USDC (2_000_000)
    // Merchant payout: 98 USDC (98_000_000)
    expect(Number(merchantPostBalance - merchantPreBalance)).to.equal(98_000_000);
    expect(Number(feePostBalance - feePreBalance)).to.equal(2_000_000);
  });

  it("5. Rejects cancellation prior to expiration timestamp", async () => {
    const orderId = Array.from(crypto.randomBytes(16));
    const orderIdBuffer = Buffer.from(orderId);
    const pixExpected = Array.from(crypto.randomBytes(32));

    const [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_order"), orderIdBuffer],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_vault"), orderIdBuffer],
      program.programId
    );

    await program.methods
      .createOrder(orderId, DEPOSIT_AMOUNT, new anchor.BN(800), pixExpected)
      .accounts({
        config: configPda,
        order: orderPda,
        orderVault: vaultPda,
        mint: mint,
        customerToken: customerAta,
        customer: customer.publicKey,
        merchant: merchant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([customer])
      .rpc();

    try {
      await program.methods
        .cancelAndRefund(orderId)
        .accounts({
          order: orderPda,
          orderVault: vaultPda,
          mint: mint,
          customerToken: customerAta,
          customer: customer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should not allow cancellation before timeout expiration");
    } catch (err: any) {
      expect(err.toString()).to.include("OrderNotExpired");
    }
  });
});