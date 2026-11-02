# 1. Configure CLI environment to Solana Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair /root/.config/solana/seekerpay-authority.json

# 2. Verify Deployer Balance (Requires ~3.5 SOL for rent exemption and state)
solana balance

# 3. Build program with Anchor deterministic verifiable build
anchor build --verifiable

# 4. Deploy Program to Solana Mainnet
solana program deploy \
  --program-id SekrBRZ111111111111111111111111111111111111 \
  target/verifiable/seekerpay_pos.so

# 5. Initialize IDL on-chain
anchor idl init \
  --filepath target/idl/seekerpay_pos.json \
  SekrBRZ111111111111111111111111111111111111