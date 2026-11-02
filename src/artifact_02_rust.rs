use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("PixSoL1111111111111111111111111111111111111");

pub const ORDER_SEED_PREFIX: &[u8] = b"pixsol_order";
pub const VAULT_SEED_PREFIX: &[u8] = b"order_vault";
pub const CONFIG_SEED_PREFIX: &[u8] = b"pixsol_config";

#[program]
pub mod pixsol_core {
    use super::*;

    /// Initializes global protocol configuration with administrative authority,
    /// protocol fee basis points (capped at 5%), and trusted relayer key.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= 500, PixSolError::FeeBpsExceedsMaximum);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.trusted_relayer = ctx.accounts.trusted_relayer.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.is_paused = false;
        config.bump = ctx.bumps.config;

        emit!(ProtocolConfigInitialized {
            admin: config.admin,
            fee_recipient: config.fee_recipient,
            trusted_relayer: config.trusted_relayer,
            protocol_fee_bps,
        });

        Ok(())
    }

    /// Creates an atomic escrow order initiated by customer on Solana Seeker.
    /// Locks stablecoin tokens inside a program-derived vault.
    pub fn create_order(
        ctx: Context<CreateOrder>,
        order_id: [u8; 16],
        amount: u64,
        timeout_seconds: i64,
        pix_tx_hash_expected: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.is_paused, PixSolError::ProtocolIsPaused);
        require!(amount > 0, PixSolError::InvalidAmount);
        require!(
            timeout_seconds >= 300 && timeout_seconds <= 86400,
            PixSolError::InvalidTimeoutRange
        );

        let clock = Clock::get()?;
        let order = &mut ctx.accounts.order;
        order.order_id = order_id;
        order.customer = ctx.accounts.customer.key();
        order.merchant = ctx.accounts.merchant.key();
        order.mint = ctx.accounts.mint.key();
        order.amount = amount;
        order.pix_tx_hash_expected = pix_tx_hash_expected;
        order.created_at = clock.unix_timestamp;
        order.expires_at = clock.unix_timestamp + timeout_seconds;
        order.status = OrderStatus::Locked;
        order.bump = ctx.bumps.order;
        order.vault_bump = ctx.bumps.order_vault;

        // Transfer funds from customer token account to program-controlled vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.customer_token.to_account_info(),
            to: ctx.accounts.order_vault.to_account_info(),
            authority: ctx.accounts.customer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(OrderCreated {
            order_id,
            customer: order.customer,
            merchant: order.merchant,
            mint: order.mint,
            amount,
            expires_at: order.expires_at,
        });

        Ok(())
    }

    /// Fulfills order upon verification of the Brazilian Pix off-ramp payment.
    /// Deducts protocol fee and transfers remaining stablecoins to merchant.
    pub fn fulfill_order(
        ctx: Context<FulfillOrder>,
        order_id: [u8; 16],
        pix_settlement_receipt: [u8; 32],
    ) -> Result<()> {
        let order = &mut ctx.accounts.order;
        let config = &ctx.accounts.config;

        require!(order.status == OrderStatus::Locked, PixSolError::InvalidOrderStatus);
        require!(
            ctx.accounts.relayer.key() == config.trusted_relayer,
            PixSolError::UnauthorizedRelayer
        );

        let total_amount = order.amount;
        let fee_amount = (total_amount as u128)
            .checked_mul(config.protocol_fee_bps as u128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(PixSolError::MathOverflow)? as u64;
        let merchant_amount = total_amount
            .checked_sub(fee_amount)
            .ok_or(PixSolError::MathOverflow)?;

        let order_id_bytes = order.order_id;
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED_PREFIX,
            order_id_bytes.as_ref(),
            &[order.vault_bump],
        ]];

        // 1. Transfer platform fee if > 0
        if fee_amount > 0 {
            let fee_cpi_accounts = Transfer {
                from: ctx.accounts.order_vault.to_account_info(),
                to: ctx.accounts.fee_recipient_token.to_account_info(),
                authority: ctx.accounts.order_vault.to_account_info(),
            };
            let fee_cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                fee_cpi_accounts,
                signer_seeds,
            );
            token::transfer(fee_cpi_ctx, fee_amount)?;
        }

        // 2. Transfer net payout to merchant token account
        let merchant_cpi_accounts = Transfer {
            from: ctx.accounts.order_vault.to_account_info(),
            to: ctx.accounts.merchant_token.to_account_info(),
            authority: ctx.accounts.order_vault.to_account_info(),
        };
        let merchant_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            merchant_cpi_accounts,
            signer_seeds,
        );
        token::transfer(merchant_cpi_ctx, merchant_amount)?;

        // 3. Close the order vault ATA to reclaim rent to merchant
        let close_cpi_accounts = CloseAccount {
            account: ctx.accounts.order_vault.to_account_info(),
            destination: ctx.accounts.merchant.to_account_info(),
            authority: ctx.accounts.order_vault.to_account_info(),
        };
        let close_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_cpi_accounts,
            signer_seeds,
        );
        token::close_account(close_cpi_ctx)?;

        order.status = OrderStatus::Fulfilled;

        emit!(OrderFulfilled {
            order_id,
            merchant: order.merchant,
            merchant_amount,
            fee_amount,
            pix_settlement_receipt,
        });

        Ok(())
    }

    /// Refunds locked funds back to customer if order expired without Pix attestation.
    pub fn cancel_and_refund(
        ctx: Context<CancelAndRefund>,
        order_id: [u8; 16],
    ) -> Result<()> {
        let order = &mut ctx.accounts.order;
        let clock = Clock::get()?;

        require!(order.status == OrderStatus::Locked, PixSolError::InvalidOrderStatus);
        require!(clock.unix_timestamp > order.expires_at, PixSolError::OrderNotExpired);

        let order_id_bytes = order.order_id;
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED_PREFIX,
            order_id_bytes.as_ref(),
            &[order.vault_bump],
        ]];

        // Return full escrowed amount back to customer
        let refund_cpi_accounts = Transfer {
            from: ctx.accounts.order_vault.to_account_info(),
            to: ctx.accounts.customer_token.to_account_info(),
            authority: ctx.accounts.order_vault.to_account_info(),
        };
        let refund_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            refund_cpi_accounts,
            signer_seeds,
        );
        token::transfer(refund_cpi_ctx, order.amount)?;

        // Close vault to reclaim rent to customer
        let close_cpi_accounts = CloseAccount {
            account: ctx.accounts.order_vault.to_account_info(),
            destination: ctx.accounts.customer.to_account_info(),
            authority: ctx.accounts.order_vault.to_account_info(),
        };
        let close_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_cpi_accounts,
            signer_seeds,
        );
        token::close_account(close_cpi_ctx)?;

        order.status = OrderStatus::Refunded;

        emit!(OrderRefunded {
            order_id,
            customer: order.customer,
            amount: order.amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::LEN,
        seeds = [CONFIG_SEED_PREFIX],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Arbitrary wallet chosen by admin as fee beneficiary
    pub fee_recipient: AccountInfo<'info>,
    /// CHECK: Trusted off-chain relayer public key for Pix attestations
    pub trusted_relayer: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct CreateOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED_PREFIX],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = customer,
        space = 8 + OrderState::LEN,
        seeds = [ORDER_SEED_PREFIX, order_id.as_ref()],
        bump
    )]
    pub order: Account<'info, OrderState>,

    #[account(
        init,
        payer = customer,
        seeds = [VAULT_SEED_PREFIX, order_id.as_ref()],
        bump,
        token::mint = mint,
        token::authority = order_vault
    )]
    pub order_vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = customer_token.owner == customer.key(),
        constraint = customer_token.mint == mint.key()
    )]
    pub customer_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub customer: Signer<'info>,

    /// CHECK: Merchant recipient address receiving settlement
    pub merchant: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct FulfillOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED_PREFIX],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [ORDER_SEED_PREFIX, order_id.as_ref()],
        bump = order.bump,
        has_one = merchant,
        has_one = mint
    )]
    pub order: Account<'info, OrderState>,

    #[account(
        mut,
        seeds = [VAULT_SEED_PREFIX, order_id.as_ref()],
        bump = order.vault_bump
    )]
    pub order_vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = merchant_token.owner == merchant.key(),
        constraint = merchant_token.mint == mint.key()
    )]
    pub merchant_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fee_recipient_token.owner == config.fee_recipient,
        constraint = fee_recipient_token.mint == mint.key()
    )]
    pub fee_recipient_token: Account<'info, TokenAccount>,

    /// CHECK: Merchant receives rent refund from vault closing
    #[account(mut)]
    pub merchant: AccountInfo<'info>,

    pub relayer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct CancelAndRefund<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED_PREFIX, order_id.as_ref()],
        bump = order.bump,
        has_one = customer,
        has_one = mint
    )]
    pub order: Account<'info, OrderState>,

    #[account(
        mut,
        seeds = [VAULT_SEED_PREFIX, order_id.as_ref()],
        bump = order.vault_bump
    )]
    pub order_vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = customer_token.owner == customer.key(),
        constraint = customer_token.mint == mint.key()
    )]
    pub customer_token: Account<'info, TokenAccount>,

    /// CHECK: Customer receives both the refunded tokens and account rent
    #[account(mut)]
    pub customer: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,            // 32
    pub fee_recipient: Pubkey,    // 32
    pub trusted_relayer: Pubkey,  // 32
    pub protocol_fee_bps: u16,    // 2
    pub is_paused: bool,          // 1
    pub bump: u8,                 // 1
}

impl ProtocolConfig {
    pub const LEN: usize = 32 + 32 + 32 + 2 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum OrderStatus {
    Locked,
    Fulfilled,
    Refunded,
}

#[account]
pub struct OrderState {
    pub order_id: [u8; 16],               // 16
    pub customer: Pubkey,                 // 32
    pub merchant: Pubkey,                 // 32
    pub mint: Pubkey,                     // 32
    pub amount: u64,                      // 8
    pub pix_tx_hash_expected: [u8; 32],   // 32
    pub created_at: i64,                  // 8
    pub expires_at: i64,                  // 8
    pub status: OrderStatus,              // 1
    pub bump: u8,                         // 1
    pub vault_bump: u8,                   // 1
}

impl OrderState {
    pub const LEN: usize = 16 + 32 + 32 + 32 + 8 + 32 + 8 + 8 + 1 + 1 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolConfigInitialized {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub trusted_relayer: Pubkey,
    pub protocol_fee_bps: u16,
}

#[event]
pub struct OrderCreated {
    pub order_id: [u8; 16],
    pub customer: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct OrderFulfilled {
    pub order_id: [u8; 16],
    pub merchant: Pubkey,
    pub merchant_amount: u64,
    pub fee_amount: u64,
    pub pix_settlement_receipt: [u8; 32],
}

#[event]
pub struct OrderRefunded {
    pub order_id: [u8; 16],
    pub customer: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum PixSolError {
    #[msg("Protocol fee basis points exceed safe threshold (max 500 bps).")]
    FeeBpsExceedsMaximum,
    #[msg("Protocol actions are currently paused by administrator.")]
    ProtocolIsPaused,
    #[msg("Order amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Order expiration timeout must be between 5 minutes and 24 hours.")]
    InvalidTimeoutRange,
    #[msg("Order is not in the required 'Locked' state.")]
    InvalidOrderStatus,
    #[msg("Caller is not authorized to attest as trusted relayer.")]
    UnauthorizedRelayer,
    #[msg("Arithmetic overflow detected during fee calculation.")]
    MathOverflow,
    #[msg("Cannot cancel order before expiration timestamp.")]
    OrderNotExpired,
}