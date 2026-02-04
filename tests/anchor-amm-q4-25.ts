import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { AnchorAmmQ425 } from "../target/types/anchor_amm_q4_25";
import {
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-amm-q4-25", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.anchorAmmQ425 as Program<AnchorAmmQ425>;
  const user = provider.wallet as anchor.Wallet;

  let mintX: PublicKey;
  let mintY: PublicKey;
  let userAtaX: PublicKey;
  let userAtaY: PublicKey;
  let config: PublicKey;
  let mintLp: PublicKey;
  let vaultX: PublicKey;
  let vaultY: PublicKey;
  let userLp: PublicKey;

  const seed = new BN(1);
  const fee = 300; // 3% fee in basis points

  before(async () => {
    // Create mint X and Y
    mintX = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6
    );

    mintY = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6
    );

    // Create user ATAs
    userAtaX = await createAssociatedTokenAccount(
      provider.connection,
      user.payer,
      mintX,
      user.publicKey
    );

    userAtaY = await createAssociatedTokenAccount(
      provider.connection,
      user.payer,
      mintY,
      user.publicKey
    );

    // Mint tokens to user
    await mintTo(
      provider.connection,
      user.payer,
      mintX,
      userAtaX,
      user.publicKey,
      1_000_000_000_000 // 1M tokens
    );

    await mintTo(
      provider.connection,
      user.payer,
      mintY,
      userAtaY,
      user.publicKey,
      1_000_000_000_000 // 1M tokens
    );

    // Derive PDAs
    [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [mintLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), config.toBuffer()],
      program.programId
    );

    vaultX = await getAssociatedTokenAddress(mintX, config, true);
    vaultY = await getAssociatedTokenAddress(mintY, config, true);
    userLp = await getAssociatedTokenAddress(mintLp, user.publicKey);
  });

  it("initializes the AMM", async () => {
    const tx = await program.methods
      .initialize(seed, fee, null)
      .accountsPartial({
        initializer: user.publicKey,
        mintX,
        mintY,
        mintLp,
        vaultX,
        vaultY,
        config,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Initialize tx:", tx);

    const configAccount = await program.account.config.fetch(config);
    assert.equal(configAccount.fee, fee);
    assert.equal(configAccount.seed.toString(), seed.toString());
  });

  it("deposits liquidity", async () => {
    const depositAmount = new BN(1_000_000_000); // LP tokens to claim
    const maxX = new BN(100_000_000_000); // Max token X
    const maxY = new BN(100_000_000_000); // Max token Y

    const tx = await program.methods
      .deposit(depositAmount, maxX, maxY)
      .accountsPartial({
        user: user.publicKey,
        mintX,
        mintY,
        config,
        mintLp,
        vaultX,
        vaultY,
        userX: userAtaX,
        userY: userAtaY,
        userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Deposit tx:", tx);

    const userLpAccount = await getAccount(provider.connection, userLp);
    assert.equal(userLpAccount.amount.toString(), depositAmount.toString());
  });

  it("swaps X for Y", async () => {
    const swapAmount = new BN(1_000_000); // Amount of X to swap
    const minOut = new BN(900_000); // Minimum Y to receive (accounting for fee + slippage)

    const vaultYBefore = await getAccount(provider.connection, vaultY);

    const tx = await program.methods
      .swap(true, swapAmount, minOut)
      .accountsPartial({
        user: user.publicKey,
        mintX,
        mintY,
        config,
        vaultX,
        vaultY,
        userX: userAtaX,
        userY: userAtaY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Swap tx:", tx);

    const vaultYAfter = await getAccount(provider.connection, vaultY);
    assert.isTrue(vaultYAfter.amount < vaultYBefore.amount);
  });

  it("swaps Y for X", async () => {
    const swapAmount = new BN(1_000_000);
    const minOut = new BN(900_000);

    const vaultXBefore = await getAccount(provider.connection, vaultX);

    const tx = await program.methods
      .swap(false, swapAmount, minOut)
      .accountsPartial({
        user: user.publicKey,
        mintX,
        mintY,
        config,
        vaultX,
        vaultY,
        userX: userAtaX,
        userY: userAtaY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Swap Y->X tx:", tx);

    const vaultXAfter = await getAccount(provider.connection, vaultX);
    assert.isTrue(vaultXAfter.amount < vaultXBefore.amount);
  });

  it("withdraws liquidity", async () => {
    const withdrawAmount = new BN(500_000_000); // LP tokens to burn
    const minX = new BN(0);
    const minY = new BN(0);

    const userLpBefore = await getAccount(provider.connection, userLp);

    const tx = await program.methods
      .withdraw(withdrawAmount, minX, minY)
      .accountsPartial({
        user: user.publicKey,
        mintX,
        mintY,
        config,
        mintLp,
        vaultX,
        vaultY,
        userX: userAtaX,
        userY: userAtaY,
        userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Withdraw tx:", tx);

    const userLpAfter = await getAccount(provider.connection, userLp);
    assert.equal(
      userLpAfter.amount.toString(),
      (BigInt(userLpBefore.amount.toString()) - BigInt(withdrawAmount.toString())).toString()
    );
  });
});
