import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SeekerPix } from "../target/types/seeker_pix";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("seeker-pix core test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SeekerPix as Program<SeekerPix>;

  let mint: PublicKey;
  let merchant: Keypair;
  let payer: Keypair;
  let merchantTokenAccount: PublicKey;
  let payerTokenAccount: PublicKey;

  const invoiceId = new anchor.BN(9901);
  const amountAtomic = new anchor.BN(50_000_000); // 50 USDC (6 decimals)
  const pixTxId = "E2E202410311200MWA0001SEEKER001";

  before(async () => {
    merchant = Keypair.generate();
    payer = Keypair.generate();

    // Airdrop SOL for rent
    const airdrop1 = await provider.connection.requestAirdrop(merchant.publicKey, 2e9);
    const airdrop2 = await provider.connection.requestAirdrop(payer.publicKey, 2e9);
    await provider.connection.confirmTransaction(airdrop1);
    await provider.connection.confirmTransaction(airdrop2);

    // Create Mint
    mint = await createMint(
      provider.connection,
      merchant,
      merchant.publicKey,
      null,
      6
    );

    // Create Token Accounts
    merchantTokenAccount = await createAccount(
      provider.connection,
      merchant,
      mint,
      merchant.publicKey
    );

    payerTokenAccount = await createAccount(
      provider.connection,
      payer,
      mint,
      payer.publicKey
    );

    // Mint funds to payer
    await mintTo(
      provider.connection,
      merchant,
      mint,
      payerTokenAccount,
      merchant.publicKey,
      100_000_000
    );
  });

  it("1. Successfully creates an invoice and vaults PDA on Seeker", async () => {
    const [invoicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .createInvoice(invoiceId, amountAtomic, pixTxId, new anchor.BN(3600))
      .accounts({
        invoice: invoicePda,
        escrowVault: vaultPda,
        tokenMint: mint,
        merchant: merchant.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([merchant])
      .rpc();

    const invoiceAccount = await program.account.invoice.fetch(invoicePda);
    expect(invoiceAccount.merchant.toBase58()).to.equal(merchant.publicKey.toBase58());
    expect(invoiceAccount.amountAtomic.toNumber()).to.equal(50_000_000);
    expect(invoiceAccount.pixTxId).to.equal(pixTxId);
    expect(invoiceAccount.isSettled).to.be.false;
  });

  it("2. Fails to create an invoice with zero amount", async () => {
    const invalidId = new anchor.BN(9902);
    const [invoicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchant.publicKey.toBuffer(), invalidId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), merchant.publicKey.toBuffer(), invalidId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .createInvoice(invalidId, new anchor.BN(0), pixTxId, new anchor.BN(3600))
        .accounts({
          invoice: invoicePda,
          escrowVault: vaultPda,
          tokenMint: mint,
          merchant: merchant.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([merchant])
        .rpc();
      expect.fail("Should have thrown InvalidAmount error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidAmount");
    }
  });

  it("3. Payer deposits SPL funds into the Seeker escrow vault", async () => {
    const [invoicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .payInvoice()
      .accounts({
        invoice: invoicePda,
        escrowVault: vaultPda,
        payerTokenAccount: payerTokenAccount,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultInfo.amount)).to.equal(50_000_000);
  });

  it("4. Settles and transfers funds to merchant while closing vault", async () => {
    const [invoicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .settleAndRelease()
      .accounts({
        invoice: invoicePda,
        escrowVault: vaultPda,
        merchantTokenAccount: merchantTokenAccount,
        merchant: merchant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([merchant])
      .rpc();

    const merchantBalance = await getAccount(provider.connection, merchantTokenAccount);
    expect(Number(merchantBalance.amount)).to.equal(50_000_000);

    const invoiceAccount = await program.account.invoice.fetch(invoicePda);
    expect(invoiceAccount.isSettled).to.be.true;

    // Vault account should now be closed
    const vaultAccountInfo = await provider.connection.getAccountInfo(vaultPda);
    expect(vaultAccountInfo).to.be.null;
  });

  it("5. Prevents double-settlement of an already settled invoice", async () => {
    const [invoicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), merchant.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .settleAndRelease()
        .accounts({
          invoice: invoicePda,
          escrowVault: vaultPda,
          merchantTokenAccount: merchantTokenAccount,
          merchant: merchant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();
      expect.fail("Should have prevented double settlement");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvoiceAlreadySettled");
    }
  });
});