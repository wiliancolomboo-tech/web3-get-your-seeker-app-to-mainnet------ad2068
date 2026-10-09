import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SeekerPayBr } from "../target/types/seeker_pay_br";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("seeker_pay_br", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SeekerPayBr as Program<SeekerPayBr>;

  const merchantAuthority = anchor.web3.Keypair.generate();
  const payer = anchor.web3.Keypair.generate();
  const attacker = anchor.web3.Keypair.generate();
  const protocolFeeAuthority = anchor.web3.Keypair.generate();

  let tokenMint: anchor.web3.PublicKey;
  let payerTokenAccount: anchor.web3.PublicKey;
  let merchantTokenAccount: anchor.web3.PublicKey;
  let protocolFeeTokenAccount: anchor.web3.PublicKey;

  let merchantPda: anchor.web3.PublicKey;
  let merchantBump: number;

  const paymentId = new anchor.BN(Date.now());
  const paymentAmount = new anchor.BN(100_000_000); // 100 USDC (6 decimals)

  before(async () => {
    // 1. Airdrop SOL to test actors
    for (const kp of [merchantAuthority, payer, attacker, protocolFeeAuthority]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // 2. Initialize Mock Mint (USDC/BRLA)
    tokenMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // 3. Create Token Accounts
    payerTokenAccount = await createAccount(
      provider.connection,
      payer,
      tokenMint,
      payer.publicKey
    );

    merchantTokenAccount = await createAccount(
      provider.connection,
      merchantAuthority,
      tokenMint,
      merchantAuthority.publicKey
    );

    protocolFeeTokenAccount = await createAccount(
      provider.connection,
      protocolFeeAuthority,
      tokenMint,
      protocolFeeAuthority.publicKey
    );

    // 4. Mint tokens to payer
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      tokenMint,
      payerTokenAccount,
      provider.wallet.publicKey,
      500_000_000
    );

    // 5. Derive Merchant PDA
    [merchantPda, merchantBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), merchantAuthority.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully registers a Brazilian Seeker merchant", async () => {
    const businessName = "Padaria Central São Paulo";
    const pixKey = "financeiro@padariacentral.com.br";

    await program.methods
      .initializeMerchant(businessName, pixKey)
      .accounts({
        merchantAccount: merchantPda,
        authority: merchantAuthority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([merchantAuthority])
      .rpc();

    const account = await program.account.merchantAccount.fetch(merchantPda);
    assert.equal(account.businessName, businessName);
    assert.equal(account.pixKey, pixKey);
    assert.equal(account.authority.toBase58(), merchantAuthority.publicKey.toBase58());
    assert.equal(account.paymentCounter.toNumber(), 0);
  });

  it("2. Locks funds in payment escrow via Seeker Mobile", async () => {
    const paymentIdBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment_escrow"),
        merchantAuthority.publicKey.toBuffer(),
        paymentIdBytes,
      ],
      program.programId
    );

    const [tokenVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    const timeoutSeconds = new anchor.BN(3600); // 1 hour

    await program.methods
      .createPaymentIntent(paymentId, paymentAmount, timeoutSeconds)
      .accounts({
        paymentEscrow: escrowPda,
        merchantAccount: merchantPda,
        tokenMint: tokenMint,
        payerTokenAccount: payerTokenAccount,
        escrowTokenVault: tokenVaultPda,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc();

    const escrowAccount = await program.account.paymentEscrow.fetch(escrowPda);
    assert.isFalse(escrowAccount.settled);
    assert.equal(escrowAccount.amount.toString(), paymentAmount.toString());

    const vaultBalance = await getAccount(provider.connection, tokenVaultPda);
    assert.equal(vaultBalance.amount.toString(), paymentAmount.toString());
  });

  it("3. Rejects settlement attempt by an attacker", async () => {
    const paymentIdBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment_escrow"),
        merchantAuthority.publicKey.toBuffer(),
        paymentIdBytes,
      ],
      program.programId
    );

    const [tokenVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .settlePayment(paymentId)
        .accounts({
          paymentEscrow: escrowPda,
          merchantAccount: merchantPda,
          merchantAuthority: attacker.publicKey, // Invalid signer
          authority: merchantAuthority.publicKey,
          merchant: merchantAuthority.publicKey,
          escrowTokenVault: tokenVaultPda,
          merchantTokenAccount: merchantTokenAccount,
          protocolFeeTokenAccount: protocolFeeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown error on unauthorized merchant settlement");
    } catch (err: any) {
      expect(err.message).to.satisfy(
        (m: string) =>
          m.includes("ConstraintRaw") ||
          m.includes("A seeds constraint was violated") ||
          m.includes("has_one")
      );
    }
  });

  it("4. Settles payment with merchant payout & protocol fee deduction (0.25%)", async () => {
    const paymentIdBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment_escrow"),
        merchantAuthority.publicKey.toBuffer(),
        paymentIdBytes,
      ],
      program.programId
    );

    const [tokenVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .settlePayment(paymentId)
      .accounts({
        paymentEscrow: escrowPda,
        merchantAccount: merchantPda,
        merchantAuthority: merchantAuthority.publicKey,
        authority: merchantAuthority.publicKey,
        merchant: merchantAuthority.publicKey,
        escrowTokenVault: tokenVaultPda,
        merchantTokenAccount: merchantTokenAccount,
        protocolFeeTokenAccount: protocolFeeTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([merchantAuthority])
      .rpc();

    const escrowAccount = await program.account.paymentEscrow.fetch(escrowPda);
    assert.isTrue(escrowAccount.settled);

    // Expected 25 basis points (0.25%) of 100_000_000 = 250_000
    const expectedFee = 250_000n;
    const expectedMerchantAmount = 100_000_000n - expectedFee;

    const merchantBalance = await getAccount(provider.connection, merchantTokenAccount);
    const protocolFeeBalance = await getAccount(provider.connection, protocolFeeTokenAccount);

    assert.equal(merchantBalance.amount.toString(), expectedMerchantAmount.toString());
    assert.equal(protocolFeeBalance.amount.toString(), expectedFee.toString());
  });

  it("5. Rejects settlement of an already settled payment", async () => {
    const paymentIdBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment_escrow"),
        merchantAuthority.publicKey.toBuffer(),
        paymentIdBytes,
      ],
      program.programId
    );
    const [tokenVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .settlePayment(paymentId)
        .accounts({
          paymentEscrow: escrowPda,
          merchantAccount: merchantPda,
          merchantAuthority: merchantAuthority.publicKey,
          authority: merchantAuthority.publicKey,
          merchant: merchantAuthority.publicKey,
          escrowTokenVault: tokenVaultPda,
          merchantTokenAccount: merchantTokenAccount,
          protocolFeeTokenAccount: protocolFeeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchantAuthority])
        .rpc();
      assert.fail("Should have prevented double settlement");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadySettled");
    }
  });
});