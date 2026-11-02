# 1. Configure Solana CLI to Mainnet
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/mainnet-deployer.json

# 2. Build Anchor Contract with deterministic verifiable flag
anchor build --verifiable

# 3. Deploy smart contract to Solana Mainnet
solana program deploy \
  --program-id target/deploy/seeker_pix-keypair.json \
  target/verifiable/seeker_pix.so

# 4. Verify deployment on-chain
solana program show PixSe11111111111111111111111111111111111111