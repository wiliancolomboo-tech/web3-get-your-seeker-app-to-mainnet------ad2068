# 1. Build and verify deterministic Anchor artifacts
anchor build --verifiable

# 2. Deploy program to Solana Mainnet-Beta
solana program deploy \
  --program-id target/deploy/seeker_pay_brazil-keypair.json \
  target/deploy/seeker_pay_brazil.so \
  --url https://api.mainnet-beta.solana.com \
  --keypair ~/.config/solana/mainnet-deployer.json

# 3. Initialize protocol parameters
yarn ts-node scripts/init-mainnet.ts \
  --fee-bps 150 \
  --fee-recipient <TREASURY_SPL_TOKEN_ACCOUNT>