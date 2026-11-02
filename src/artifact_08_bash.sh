# 1. Setup Solana CLI configured to Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/seeker-deployer.json

# 2. Build deterministic Anchor artifacts
anchor build --verifiable

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Mainnet-Beta with priority fees
solana program deploy \
  --program-id target/deploy/seeker_pay_br-keypair.json \
  target/deploy/seeker_pay_br.so \
  --with-compute-unit-price 50000

# 5. Initialize verification IDL on Mainnet
anchor idl init \
  --filepath target/idl/seeker_pay_br.json \
  SeekerPay11111111111111111111111111111111111