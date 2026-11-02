use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

declare_id!("Pix1111111111111111111111111111111111111111");

pub const SEED_INVOICE: &[u8] = b"invoice";
pub const SEED_VAULT: &[u8] = b"vault";
pub const MAX_PIX_ID_LEN: usize = 64;

#[program]
pub mod seeker_pix {
    use super::*;

    /// Initializes a merchant invoice escrow on Solana Seeker.
    pub fn create_invoice(
        ctx: Context<CreateInvoice>,
        invoice_id: u64,
        amount_atomic: u64,
        pix_tx_id: String,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(amount_atomic > 0, PixError::InvalidAmount);
        require!(
            pix_tx_id.len() <= MAX_PIX_ID_LEN,
            PixError::PixIdExceedsMaxLength
        );

        let clock = Clock::get()?;
        let invoice = &mut ctx.accounts.invoice;
        invoice.merchant = ctx.accounts.merchant.key();
        invoice.mint = ctx.accounts.token_mint.key();
        invoice.escrow_vault = ctx.accounts.escrow_vault.key();
        invoice.invoice_id = invoice_id;
        invoice.amount_atomic = amount_atomic;
        invoice.pix_tx_id = pix_tx_id.clone();
        invoice.is_settled = false;
        invoice.created_at = clock.unix_timestamp;
        invoice.expires_at = clock
            .unix_timestamp
            .checked_add(timeout_seconds)
            .ok_or(PixError::MathOverflow)?;
        invoice.bump = ctx.bumps.invoice;
        invoice.vault_bump = ctx.bumps.escrow_vault;

        emit!(InvoiceCreatedEvent {
            merchant: invoice.merchant,
            invoice_id,
            amount_atomic,
            pix_tx_id,
            expires_at: invoice.expires_at,
        });

        Ok(())
    }

    /// Payer deposits SPL tokens (e.g. USDC / BRZ) into the SeekerPix escrow vault.
    pub fn pay_invoice(ctx: Context<PayInvoice>) -> Result<()> {
        let clock = Clock::get()?;
        let invoice = &mut ctx.accounts.invoice;

        require!(!invoice.is_settled, PixError::InvoiceAlreadySettled);
        require!(clock.unix_timestamp <= invoice.expires_at, PixError::InvoiceExpired);

        // CPI: Transfer funds from payer to escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, invoice.amount_atomic)?;

        emit!(InvoicePaidEvent {
            invoice_id: invoice.invoice_id,
            payer: ctx.accounts.payer.key(),
            amount_atomic: invoice.amount_atomic,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Merchant or Relayer settles the invoice, transferring funds to the merchant account and closing the vault.
    pub fn settle_and_release(ctx: Context<SettleInvoice>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        require!(!invoice.is_settled, PixError::InvoiceAlreadySettled);

        let merchant_key = invoice.merchant;
        let invoice_id_bytes = invoice.invoice_id.to_le_bytes();
        let vault_bump = invoice.vault_bump;

        let seeds = &[
            SEED_VAULT,
            merchant_key.as_ref(),
            invoice_id_bytes.as_ref(),
            &[vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // CPI: Transfer funds from escrow vault to merchant token account
        let vault_balance = ctx.accounts.escrow_vault.amount;
        require!(vault_balance >= invoice.amount_atomic, PixError::InsufficientVaultBalance);

        let cpi_transfer = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.merchant_token_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let token_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(token_program.clone(), cpi_transfer, signer_seeds),
            invoice.amount_atomic,
        )?;

        // Close escrow token account to release rent back to merchant
        let cpi_close = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: ctx.accounts.merchant.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(token_program, cpi_close, signer_seeds))?;

        invoice.is_settled = true;

        emit!(InvoiceSettledEvent {
            invoice_id: invoice.invoice_id,
            merchant: ctx.accounts.merchant.key(),
            settled_amount: invoice.amount_atomic,
            pix_tx_id: invoice.pix_tx_id.clone(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Refunds payer if invoice expired without settlement.
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let clock = Clock::get()?;
        let invoice = &ctx.accounts.invoice;

        require!(!invoice.is_settled, PixError::InvoiceAlreadySettled);
        require!(clock.unix_timestamp > invoice.expires_at, PixError::InvoiceNotExpired);

        let merchant_key = invoice.merchant;
        let invoice_id_bytes = invoice.invoice_id.to_le_bytes();
        let vault_bump = invoice.vault_bump;

        let seeds = &[
            SEED_VAULT,
            merchant_key.as_ref(),
            invoice_id_bytes.as_ref(),
            &[vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let balance = ctx.accounts.escrow_vault.amount;
        if balance > 0 {
            let cpi_transfer = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.refund_destination.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_transfer,
                    signer_seeds,
                ),
                balance,
            )?;
        }

        // Close escrow account, return rent to merchant
        let cpi_close = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: ctx.accounts.merchant.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_close,
            signer_seeds,
        ))?;

        emit!(InvoiceRefundedEvent {
            invoice_id: invoice.invoice_id,
            refund_amount: balance,
            refunded_to: ctx.accounts.refund_destination.key(),
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(invoice_id: u64, amount_atomic: u64, pix_tx_id: String)]
pub struct CreateInvoice<'info> {
    #[account(
        init,
        payer = merchant,
        space = 8 + Invoice::INIT_SPACE,
        seeds = [SEED_INVOICE, merchant.key().as_ref(), &invoice_id.to_le_bytes()],
        bump
    )]
    pub invoice: Account<'info, Invoice>,

    #[account(
        init,
        payer = merchant,
        seeds = [SEED_VAULT, merchant.key().as_ref(), &invoice_id.to_le_bytes()],
        bump,
        token::mint = token_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    /// Token mint accepted for this invoice (e.g., USDC or BRZ)
    pub token_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PayInvoice<'info> {
    #[account(
        mut,
        seeds = [SEED_INVOICE, invoice.merchant.as_ref(), &invoice.invoice_id.to_le_bytes()],
        bump = invoice.bump
    )]
    pub invoice: Account<'info, Invoice>,

    #[account(
        mut,
        seeds = [SEED_VAULT, invoice.merchant.as_ref(), &invoice.invoice_id.to_le_bytes()],
        bump = invoice.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleInvoice<'info> {
    #[account(
        mut,
        seeds = [SEED_INVOICE, invoice.merchant.as_ref(), &invoice.invoice_id.to_le_bytes()],
        bump = invoice.bump,
        has_one = merchant
    )]
    pub invoice: Account<'info, Invoice>,

    #[account(
        mut,
        seeds = [SEED_VAULT, invoice.merchant.as_ref(), &invoice.invoice_id.to_le_bytes()],
        bump = invoice.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = merchant_token_account.owner == merchant.key() @ PixError::InvalidMerchantTokenAccount,
        constraint = merchant_token_account.mint == invoice.mint @ PixError::InvalidMint
    )]
    pub merchant_token_account: Account<'info, TokenAccount>,

    /// Can be signed by merchant or authorized relayer
    #[account(mut)]
    pub merchant: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(
        mut,
        seeds = [SEED_INVOICE, invoice.merchant.as_ref(), &invoice.invoice_id.to_le_bytes()],
        bump = invoice.bump,
        has_one = merchant
    )]
    pub invoice: Account<'info, Invoice>,

    #[account(
        mut,
        seeds = [SEED_VAULT, invoice.merchant.as_ref(), &invoice.invoice_id.to_le_bytes()],
        bump = invoice.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub refund_destination: Account<'info, TokenAccount>,

    /// Rent receiver
    #[account(mut)]
    pub merchant: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Invoice {
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub escrow_vault: Pubkey,
    pub invoice_id: u64,
    pub amount_atomic: u64,
    #[max_len(64)]
    pub pix_tx_id: String,
    pub is_settled: bool,
    pub created_at: i64,
    pub expires_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[event]
pub struct InvoiceCreatedEvent {
    pub merchant: Pubkey,
    pub invoice_id: u64,
    pub amount_atomic: u64,
    pub pix_tx_id: String,
    pub expires_at: i64,
}

#[event]
pub struct InvoicePaidEvent {
    pub invoice_id: u64,
    pub payer: Pubkey,
    pub amount_atomic: u64,
    pub timestamp: i64,
}

#[event]
pub struct InvoiceSettledEvent {
    pub invoice_id: u64,
    pub merchant: Pubkey,
    pub settled_amount: u64,
    pub pix_tx_id: String,
    pub timestamp: i64,
}

#[event]
pub struct InvoiceRefundedEvent {
    pub invoice_id: u64,
    pub refund_amount: u64,
    pub refunded_to: Pubkey,
}

#[error_code]
pub enum PixError {
    #[msg("Payment amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Pix Transaction ID exceeds maximum allowed length of 64 characters.")]
    PixIdExceedsMaxLength,
    #[msg("This invoice has already been settled.")]
    InvoiceAlreadySettled,
    #[msg("This invoice has expired.")]
    InvoiceExpired,
    #[msg("This invoice has not yet expired.")]
    InvoiceNotExpired,
    #[msg("Escrow vault has insufficient funds for settlement.")]
    InsufficientVaultBalance,
    #[msg("The merchant token account does not match the invoice owner.")]
    InvalidMerchantTokenAccount,
    #[msg("The token mint does not match the invoice.")]
    InvalidMint,
    #[msg("Arithmetic overflow detected.")]
    MathOverflow,
}