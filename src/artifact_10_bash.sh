# 1. Build optimized deterministic Solana SBF binary
anchor build --verifiable

# 2. Deploy binary to Solana Mainnet-Beta
solana program deploy \
  --program-id target/deploy/seeker_pix-keypair.json \
  target/verifiable/seeker_pix.so \
  --url https://api.mainnet-beta.solana.com \
  --keypair ~/.config/solana/mainnet-deployer.json

# 3. Initialize IDL on-chain
anchor idl init \
  --filepath target/idl/seeker_pix.json \
  Pix1111111111111111111111111111111111111111 \
  --provider.cluster mainnet \
  --provider.wallet ~/.config/solana/mainnet-deployer.json