# 1. Switch CLI to Solana Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com

# 2. Verify Deployer Keypair Balance (Requires ~3.5 SOL for program rent allocation)
solana balance ~/.config/solana/mainnet-deployer.json

# 3. Build optimized BPF bytecode with verified Anchor build
anchor build --verifiable

# 4. Deploy Program to Solana Mainnet
solana program deploy \
  --program-id target/deploy/pixsol_core-keypair.json \
  target/deploy/pixsol_core.so

# 5. Initialize Protocol Global Config
yarn ts-node scripts/initialize-protocol.ts \
  --admin ~/.config/solana/mainnet-deployer.json \
  --feeRecipient <ENTERPRISE_TREASURY_PUBKEY> \
  --trustedRelayer <RELAYER_SERVER_PUBKEY> \
  --feeBps 25