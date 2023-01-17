import { smock } from "@defi-wonderland/smock";
import BigNumber from "bignumber.js";
import chai from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";
import { deployments } from "hardhat";

import { convertToUnit, scaleDownBy } from "../../helpers/utils";
import { AccessControlManager, Comptroller, MockToken, PoolRegistry, PriceOracle, VToken } from "../../typechain";
import { Error } from "../hardhat/util/Errors";

const { expect } = chai;
chai.use(smock.matchers);

const setupTest = deployments.createFixture(async ({ deployments, getNamedAccounts, ethers }: any) => {
  await deployments.fixture(["Oracle", "Pools"]);
  const { deployer, acc1, acc2 } = await getNamedAccounts();
  const PoolRegistry: PoolRegistry = await ethers.getContract("PoolRegistry");
  const AccessControlManager = await ethers.getContract("AccessControlManager");
  const RiskFund = await ethers.getContract("RiskFund");
  const VTokenFactory = await ethers.getContract("VTokenProxyFactory");
  const JumpRateModelFactory = await ethers.getContract("JumpRateModelFactory");
  const WhitePaperRateFactory = await ethers.getContract("WhitePaperInterestRateModelFactory");
  const ProtocolShareReserve = await ethers.getContract("ProtocolShareReserve");

  const PriceOracle = await ethers.getContract("ResilientOracle");

  const pools = await PoolRegistry.callStatic.getAllPools();
  const Comptroller = await ethers.getContractAt("Comptroller", pools[0].comptroller);

  const BNX = await ethers.getContract("MockBNX");
  const BSW = await ethers.getContract("MockBSW");

  // Set Oracle
  await Comptroller.setPriceOracle(PriceOracle.address);

  const vBNXAddress = await PoolRegistry.getVTokenForAsset(Comptroller.address, BNX.address);
  const vBSWAddress = await PoolRegistry.getVTokenForAsset(Comptroller.address, BSW.address);

  const vBNX = await ethers.getContractAt("VToken", vBNXAddress);
  const vBSW = await ethers.getContractAt("VToken", vBSWAddress);

  // Enter Markets
  await Comptroller.connect(await ethers.getSigner(acc1)).enterMarkets([vBNX.address, vBSW.address]);
  await Comptroller.connect(await ethers.getSigner(acc2)).enterMarkets([vBNX.address, vBSW.address]);

  // Enable access to setting supply and borrow caps
  await AccessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "setMarketSupplyCaps(address[],uint256[])",
    deployer,
  );
  await AccessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "setMarketBorrowCaps(address[],uint256[])",
    deployer,
  );

  // Set supply caps
  const supply = convertToUnit(10, 18);
  await Comptroller.setMarketSupplyCaps([vBNX.address, vBSW.address], [supply, supply]);

  // Set borrow caps
  const borrowCap = convertToUnit(10, 18);
  await Comptroller.setMarketBorrowCaps([vBNX.address, vBSW.address], [borrowCap, borrowCap]);

  const vBNXPrice: BigNumber = new BigNumber(
    scaleDownBy((await PriceOracle.getUnderlyingPrice(vBNX.address)).toString(), 18),
  ).toFixed(3);
  const vBSWPrice: BigNumber = new BigNumber(
    scaleDownBy((await PriceOracle.getUnderlyingPrice(vBSW.address)).toString(), 18),
  ).toFixed(3);

  return {
    fixture: {
      PoolRegistry,
      AccessControlManager,
      RiskFund,
      VTokenFactory,
      JumpRateModelFactory,
      WhitePaperRateFactory,
      ProtocolShareReserve,
      PriceOracle,
      Comptroller,
      vBNX,
      vBSW,
      BNX,
      BSW,
      deployer,
      acc1,
      acc2,
      vBNXPrice,
      vBSWPrice,
    },
  };
});

describe("Positive Cases", () => {
  let fixture;
  let PoolRegistry: PoolRegistry;
  let AccessControlManager: AccessControlManager;
  let Comptroller: Comptroller;
  let vBNX: VToken;
  let vBSW: VToken;
  let BNX: MockToken;
  let BSW: MockToken;
  let acc1: string;
  let acc2: string;
  let vBNXPrice: BigNumber;
  let vBSWPrice: BigNumber;

  beforeEach(async () => {
    ({ fixture } = await setupTest());
    ({ PoolRegistry, AccessControlManager, Comptroller, vBNX, vBSW, BNX, BSW, acc1, acc2, vBNXPrice, vBSWPrice } =
      fixture);
  });
  describe("Setup", () => {
    it("PoolRegistry should be initialized properly", async function () {
      await expect(
        PoolRegistry.initialize(
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
        ),
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("PoolRegistry has the required permissions ", async function () {
      let canCall = await AccessControlManager.connect(Comptroller.address).isAllowedToCall(
        PoolRegistry.address,
        "setCollateralFactor(address,uint256,uint256)",
      );
      expect(canCall).to.be.true;

      canCall = await AccessControlManager.connect(Comptroller.address).isAllowedToCall(
        PoolRegistry.address,
        "supportMarket(address)",
      );
      expect(canCall).to.be.true;

      canCall = await AccessControlManager.connect(Comptroller.address).isAllowedToCall(
        PoolRegistry.address,
        "setLiquidationIncentive(uint256)",
      );
      expect(canCall).to.be.true;
    });
  });

  describe("Main Operations", () => {
    const mintAmount: number = 1e6;
    const collateralFactor: number = 0.7;
    let acc1Signer: Signer;
    let acc2Signer: Signer;

    beforeEach(async () => {
      acc1Signer = await ethers.getSigner(acc1);
      acc2Signer = await ethers.getSigner(acc2);

      await BNX.connect(acc2Signer).faucet(mintAmount * 100);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount * 10);

      // Fund 2nd account
      await BSW.connect(acc1Signer).faucet(mintAmount * 100);
      await BSW.connect(acc1Signer).approve(vBSW.address, mintAmount * 100);
    });

    it("Mint, Redeem, Borrow, Repay", async function () {
      let error: BigNumber;
      let liquidity: BigNumber;
      let shortfall: BigNumber;
      let balance: BigNumber;
      let borrowBalance: BigNumber;
      // //////////
      // // MINT //
      // //////////
      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      [error, balance, borrowBalance] = await vBNX.connect(acc2Signer).getAccountSnapshot(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(balance).to.equal(mintAmount);
      expect(borrowBalance).to.equal(0);
      [error, liquidity, shortfall] = await Comptroller.connect(acc2Signer).getAccountLiquidity(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(liquidity).to.equal(new BigNumber(mintAmount * collateralFactor).multipliedBy(vBNXPrice));
      expect(shortfall).to.equal(0);
      // ////////////
      // // Borrow //
      // ////////////
      // Supply WBTC to market from 2nd account
      await expect(vBSW.connect(acc1Signer).mint(mintAmount))
        .to.emit(vBSW, "Mint")
        .withArgs(await acc1Signer.getAddress(), mintAmount, mintAmount);

      [error, balance, borrowBalance] = await vBSW
        .connect(acc2Signer)
        .getAccountSnapshot(await acc1Signer.getAddress());
      expect(error).to.equal(Error.NO_ERROR);
      expect(balance).to.equal(mintAmount);
      expect(borrowBalance).to.equal(0);

      [error, liquidity, shortfall] = await Comptroller.connect(acc1Signer).getAccountLiquidity(acc1);
      expect(error).to.equal(Error.NO_ERROR);
      expect(liquidity).to.equal(new BigNumber(mintAmount * collateralFactor).multipliedBy(vBSWPrice));
      expect(shortfall).to.equal(0);

      const bswBorrowAmount = 1e4;

      await expect(vBSW.connect(acc2Signer).borrow(bswBorrowAmount))
        .to.emit(vBSW, "Borrow")
        .withArgs(acc2, bswBorrowAmount, bswBorrowAmount, bswBorrowAmount);

      [error, balance, borrowBalance] = await vBSW.connect(acc2Signer).getAccountSnapshot(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(balance).to.equal(0);
      expect(borrowBalance).to.equal(bswBorrowAmount);
      // ////////////
      // // REDEEM //
      // ////////////
      const redeemAmount = 10e3;
      await expect(vBNX.connect(acc2Signer).redeem(redeemAmount))
        .to.emit(vBNX, "Redeem")
        .withArgs(acc2, redeemAmount, redeemAmount);

      [error, balance, borrowBalance] = await vBNX.connect(acc2Signer).getAccountSnapshot(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(balance).to.equal(mintAmount - redeemAmount);
      expect(borrowBalance).to.equal(0);
      [error, balance, borrowBalance] = await vBSW.connect(acc2Signer).getAccountSnapshot(acc2);
      const preComputeLiquidity =
        (mintAmount - redeemAmount) * collateralFactor * vBNXPrice - Number(borrowBalance) * vBSWPrice;
      [error, liquidity, shortfall] = await Comptroller.connect(acc2Signer).getAccountLiquidity(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(liquidity).to.equal(preComputeLiquidity);
      expect(shortfall).to.equal(0);
      // ////////////
      // // REPAY //
      // //////////
      await BSW.connect(acc2Signer).faucet(bswBorrowAmount);
      await BSW.connect(acc2Signer).approve(vBSW.address, bswBorrowAmount);
      await expect(vBSW.connect(acc2Signer).repayBorrow(bswBorrowAmount)).to.emit(vBSW, "RepayBorrow");

      [error, balance, borrowBalance] = await vBNX.connect(acc2Signer).getAccountSnapshot(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(balance).to.equal(mintAmount - redeemAmount);
      expect(borrowBalance).to.equal(0);

      [error, liquidity, shortfall] = await Comptroller.connect(acc2Signer).getAccountLiquidity(acc2);
      expect(error).to.equal(Error.NO_ERROR);
      expect(liquidity).to.equal((mintAmount - redeemAmount) * collateralFactor * vBNXPrice);
      expect(shortfall).to.equal(0);
    });
  });
});

describe("Straight Cases For Single User Liquidation and healing", () => {
  let fixture;
  let Comptroller: Comptroller;
  let vBNX: VToken;
  let vBSW: VToken;
  let BNX: MockToken;
  let BSW: MockToken;
  let acc1: string;
  let acc2: string;
  let vBSWPrice: BigNumber;
  let vBNXPrice: BigNumber;

  beforeEach(async () => {
    ({ fixture } = await setupTest());
    ({ Comptroller, vBNX, vBSW, BNX, BSW, acc1, acc2, vBNXPrice, vBSWPrice } = fixture);
  });

  describe("Force Liquidation of user via Comptroller", () => {
    const mintAmount = convertToUnit("1", 8);
    let acc1Signer: Signer;
    let acc2Signer: Signer;
    const bswBorrowAmount = 1e4;
    let result;

    beforeEach(async () => {
      acc1Signer = await ethers.getSigner(acc1);
      acc2Signer = await ethers.getSigner(acc2);

      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      // Fund 2nd account
      await BSW.connect(acc1Signer).faucet(mintAmount);
      await BSW.connect(acc1Signer).approve(vBSW.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      // borrow
      // Supply WBTC to market from 2nd account
      await expect(vBSW.connect(acc1Signer).mint(mintAmount))
        .to.emit(vBSW, "Mint")
        .withArgs(acc1, mintAmount, mintAmount);
      // It should revert when try to borrow more than liquidity
      await expect(vBSW.connect(acc2Signer).borrow(8e10)).to.be.revertedWithCustomError(
        Comptroller,
        "InsufficientLiquidity",
      );
      await expect(vBSW.connect(acc2Signer).borrow(bswBorrowAmount))
        .to.emit(vBSW, "Borrow")
        .withArgs(acc2, bswBorrowAmount, bswBorrowAmount, bswBorrowAmount);

      // Approve more assets for liquidation
      await BSW.connect(acc1Signer).faucet(bswBorrowAmount);
      await BSW.connect(acc1Signer).approve(vBSW.address, bswBorrowAmount);
    });

    it("Should revert when repay amount on liquidation is not equal to borrow amount", async function () {
      // Repay amount does not make borrower principal to zero
      const repayAmount = bswBorrowAmount / 2;
      const param = {
        vTokenCollateral: vBNX.address,
        vTokenBorrowed: vBSW.address,
        repayAmount: repayAmount,
      };
      await expect(Comptroller.connect(acc1Signer).liquidateAccount(acc2, [param])).to.be.revertedWith(
        "Nonzero borrow balance after liquidation",
      );
    });

    it("Should success on liquidation when repayamount is equal to borrowing", async function () {
      const param = {
        vTokenCollateral: vBNX.address,
        vTokenBorrowed: vBSW.address,
        repayAmount: bswBorrowAmount,
      };
      result = await Comptroller.connect(acc1Signer).liquidateAccount(acc2, [param]);
      // Liquidation Mantissa is set for 1
      const seizeTokens = (bswBorrowAmount * vBSWPrice) / vBNXPrice;
      await expect(result)
        .to.emit(vBSW, "LiquidateBorrow")
        .withArgs(acc1, acc2, bswBorrowAmount, vBNX.address, seizeTokens.toFixed(0));

      const liquidatorBalance = await vBNX.connect(acc1Signer).balanceOf(acc1);
      expect(liquidatorBalance).to.equal(seizeTokens.toFixed(0));
    });
  });

  describe("Liquidation of user via Vtoken", () => {
    let mintAmount = convertToUnit("1", 8);
    let acc1Signer: Signer;
    let acc2Signer: Signer;
    let bswBorrowAmount = convertToUnit("1", 4);

    beforeEach(async () => {
      acc1Signer = await ethers.getSigner(acc1);
      acc2Signer = await ethers.getSigner(acc2);

      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      // Fund 2nd account
      await BSW.connect(acc1Signer).faucet(mintAmount);
      await BSW.connect(acc1Signer).approve(vBSW.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      // borrow
      // Supply WBTC to market from 2nd account
      await expect(vBSW.connect(acc1Signer).mint(mintAmount))
        .to.emit(vBSW, "Mint")
        .withArgs(acc1, mintAmount, mintAmount);
      await expect(vBSW.connect(acc2Signer).borrow(bswBorrowAmount))
        .to.emit(vBSW, "Borrow")
        .withArgs(acc2, bswBorrowAmount, bswBorrowAmount, bswBorrowAmount);

      // Approve more assets for liquidation
      await BSW.connect(acc1Signer).faucet(convertToUnit("1", 18));
      await BSW.connect(acc1Signer).approve(vBSW.address, convertToUnit("1", 18));
    });

    it("Should revert when liquidation is called through vToken and does not met minCollateral Criteria", async function () {
      await expect(vBSW.connect(acc1Signer).liquidateBorrow(acc2, bswBorrowAmount, vBSW.address))
        .to.be.revertedWithCustomError(Comptroller, "MinimalCollateralViolated")
        .withArgs("100000000000000000000", "15999000000");
    });

    it("Should revert when liquidation is called through vToken and no shortfall", async function () {
      // Mint and Increase collateral of the user
      mintAmount = convertToUnit("1", 18);
      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      // Liquidation
      await expect(
        vBSW.connect(acc1Signer).liquidateBorrow(acc2, bswBorrowAmount, vBSW.address),
      ).to.be.revertedWithCustomError(Comptroller, "InsufficientShortfall");
    });

    it("Should revert when liquidation is called through vToken and trying to seize more tokens", async function () {
      // Mint and Incrrease collateral of the user
      mintAmount = convertToUnit("1", 18);
      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      // price manipulation and borrow to overcome insufficient shortfall
      bswBorrowAmount = convertToUnit("1", 18);
      await vBSW.connect(acc2Signer).borrow(bswBorrowAmount);
      const dummyPriceOracle = await smock.fake<PriceOracle>("PriceOracle");
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBSW.address).returns(convertToUnit("100", 40));
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBNX.address).returns(convertToUnit("100", 18));
      await Comptroller.setPriceOracle(dummyPriceOracle.address);
      // Liquidation
      await expect(vBSW.connect(acc1Signer).liquidateBorrow(acc2, 201, vBNX.address)).to.be.revertedWith(
        "LIQUIDATE_SEIZE_TOO_MUCH",
      );
    });

    it("Should revert when liquidation is called through vToken and trying to pay too much", async function () {
      // Mint and Incrrease collateral of the user
      mintAmount = convertToUnit("1", 18);
      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      // price manipulation and borrow to overcome insufficient shortfall
      bswBorrowAmount = convertToUnit("1", 18);
      await vBSW.connect(acc2Signer).borrow(bswBorrowAmount);
      const dummyPriceOracle = await smock.fake<PriceOracle>("PriceOracle");
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBSW.address).returns(convertToUnit("1", 20));
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBNX.address).returns(convertToUnit("100", 18));
      await Comptroller.setPriceOracle(dummyPriceOracle.address);
      // Liquidation
      await expect(
        vBSW.connect(acc1Signer).liquidateBorrow(acc2, convertToUnit("1", 18), vBNX.address),
      ).to.be.revertedWithCustomError(Comptroller, "TooMuchRepay");
    });

    it("Should success when liquidation is called through vToken", async function () {
      // Mint and Incrrease collateral of the user
      mintAmount = convertToUnit("1", 18);
      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);

      // price manipulation and borrow to overcome insufficient shortfall
      bswBorrowAmount = convertToUnit("1", 18);
      await vBSW.connect(acc2Signer).borrow(bswBorrowAmount);
      const dummyPriceOracle = await smock.fake<PriceOracle>("PriceOracle");
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBSW.address).returns(convertToUnit("100", 18));
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBNX.address).returns(convertToUnit("100", 18));
      await Comptroller.setPriceOracle(dummyPriceOracle.address);
      const repayAmount = convertToUnit("1", 9);
      // Liquidation
      await expect(vBSW.connect(acc1Signer).liquidateBorrow(acc2, repayAmount, vBNX.address))
        .to.emit(vBSW, "LiquidateBorrow")
        .withArgs(acc1, acc2, repayAmount, vBNX.address, repayAmount);
      const protocolShareMantissa = await vBSW.protocolSeizeShareMantissa();
      const protocolShareTokens = ((repayAmount * protocolShareMantissa) / 1e18).toString();

      const liquidatorBalance = await vBNX.connect(acc1Signer).balanceOf(acc1);
      expect(liquidatorBalance).to.equal((repayAmount - protocolShareTokens).toString());
    });
  });

  describe("Heal Borrow and Forgive account", () => {
    const mintAmount = convertToUnit("1", 8);
    let acc1Signer: Signer;
    let acc2Signer: Signer;
    const bswBorrowAmount = 1e4;
    let result;

    beforeEach(async () => {
      acc1Signer = await ethers.getSigner(acc1);
      acc2Signer = await ethers.getSigner(acc2);

      await BNX.connect(acc2Signer).faucet(mintAmount);
      await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);

      // Fund 2nd account
      await BSW.connect(acc1Signer).faucet(mintAmount);
      await BSW.connect(acc1Signer).approve(vBSW.address, mintAmount);

      await expect(vBNX.connect(acc2Signer).mint(mintAmount))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, mintAmount, mintAmount);
      // borrow
      // Supply WBTC to market from 2nd account
      await expect(vBSW.connect(acc1Signer).mint(mintAmount))
        .to.emit(vBSW, "Mint")
        .withArgs(acc1, mintAmount, mintAmount);
      // It should revert when try to borrow more than liquidity
      await expect(vBSW.connect(acc2Signer).borrow(bswBorrowAmount))
        .to.emit(vBSW, "Borrow")
        .withArgs(acc2, bswBorrowAmount, bswBorrowAmount, bswBorrowAmount);

      // Approve more assets for liquidation
      await BSW.connect(acc1Signer).faucet(bswBorrowAmount);
      await BSW.connect(acc1Signer).approve(vBSW.address, bswBorrowAmount);
    });

    it("Should revert when total collateral is greater then minLiquidation threshold", async function () {
      // Increase mint to make collateral large then min threshold liquidation
      await BNX.connect(acc2Signer).faucet(convertToUnit("1", 18));
      await BNX.connect(acc2Signer).approve(vBNX.address, convertToUnit("1", 18));
      await expect(vBNX.connect(acc2Signer).mint(convertToUnit("1", 18)))
        .to.emit(vBNX, "Mint")
        .withArgs(acc2, convertToUnit("1", 18), convertToUnit("1", 18));
      // heal
      await expect(Comptroller.connect(acc1Signer).healAccount(acc2))
        .to.be.revertedWithCustomError(Comptroller, "CollateralExceedsThreshold")
        .withArgs("100000000000000000000", "159990000015999000000");
    });

    it("Should revert on healing if borrow is less then collateral amount", async function () {
      await expect(Comptroller.connect(acc1Signer).healAccount(acc2))
        .to.be.revertedWithCustomError(Comptroller, "CollateralExceedsThreshold")
        .withArgs(bswBorrowAmount * vBSWPrice, vBNXPrice * mintAmount);
    });

    it("Should success on healing and forgive borrow account", async function () {
      // Increase price of borrowed underlying tokens to surpass available collateral
      const dummyPriceOracle = await smock.fake<PriceOracle>("PriceOracle");
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBSW.address).returns(convertToUnit("1", 20));
      dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBNX.address).returns(convertToUnit("1", 15));
      await Comptroller.setPriceOracle(dummyPriceOracle.address);
      /*
      Calculations
      snapshot.totalCollateral 100000  // (bnxPrice * mint amount) / mantissa
      snapshot.borrows 1000000    //  (bswPrice * bswBorrowAmount) / mantissa
      percantage 0.1   (collateral/borrow) * mantissa
      repaymentAmount 1000       percentage*borrowBalance 
      borrowBalance 10000
      */
      const collateralAmount = 1e5;
      const borrowAmount = 1e6;
      const percantageOfRepay = (collateralAmount / borrowAmount) * 1e18;
      const repayAmount = bswBorrowAmount * (percantageOfRepay / 1e18);
      const badDebt = bswBorrowAmount - repayAmount;
      result = await Comptroller.connect(acc1Signer).healAccount(acc2);
      await expect(result)
        .to.emit(vBSW, "RepayBorrow")
        .withArgs(vBSW.address, acc2, bswBorrowAmount - repayAmount, repayAmount, 0)
        .to.emit(vBSW, "BadDebtIncreased")
        .withArgs(acc2, bswBorrowAmount - repayAmount, 0, badDebt);

      // Forgive Account
      result = await vBSW.connect(acc2Signer).getAccountSnapshot(acc2);
      expect(result.error).to.equal(Error.NO_ERROR);
      expect(result.vTokenBalance).to.equal(0);
      expect(result.borrowBalance).to.equal(0);
      expect((await vBSW.badDebt()).toString()).to.equal(badDebt.toString());
    });
  });
});

describe("Risk Fund and Auction related scenarios", () => {
  let fixture;
  let Comptroller: Comptroller;
  let vBNX: VToken;
  let vBSW: VToken;
  let BNX: MockToken;
  let BSW: MockToken;
  let acc1: string;
  let acc2: string;
  let ProtocolShareReserve: ProtocolShareReserve;
  let deployer: string
  beforeEach(async () => {
  ({ fixture } = await setupTest());
  ({ Comptroller, vBNX, vBSW, BNX, BSW, acc1, acc2, ProtocolShareReserve, deployer } = fixture);
  });
  describe("Generate risk fund swap it to base asset", () => {
  const mintAmount = convertToUnit("1", 8);
  let acc1Signer: Signer;
  let acc2Signer: Signer;
  let deployerSigner;
  const bswBorrowAmount = 1e4;
  beforeEach(async () => {
  acc1Signer = await ethers.getSigner(acc1);
  acc2Signer = await ethers.getSigner(acc2);
  deployerSigner = await ethers.getSigner(deployer);
  await BNX.connect(acc2Signer).faucet(mintAmount);
  await BNX.connect(acc2Signer).approve(vBNX.address, mintAmount);
  // Fund 2nd account
  await BSW.connect(acc1Signer).faucet(mintAmount);
  await BSW.connect(acc1Signer).approve(vBSW.address, mintAmount);
  await expect(vBNX.connect(acc2Signer).mint(mintAmount))
  .to.emit(vBNX, "Mint")
  .withArgs(acc2, mintAmount, mintAmount);
  //borrow
  //Supply WBTC to market from 2nd account
  await expect(vBSW.connect(acc1Signer).mint(mintAmount))
  .to.emit(vBSW, "Mint")
  .withArgs(acc1, mintAmount, mintAmount);
  //It should revert when try to borrow more than liquidity
  await expect(vBSW.connect(acc2Signer).borrow(8e10)).to.be.revertedWithCustomError(
  Comptroller,
  "InsufficientLiquidity",
  );
  await expect(vBSW.connect(acc2Signer).borrow(bswBorrowAmount))
  .to.emit(vBSW, "Borrow")
  .withArgs(acc2, bswBorrowAmount, bswBorrowAmount, bswBorrowAmount);
  //Approve more assets for liquidation
  await BSW.connect(acc1Signer).faucet(bswBorrowAmount);
  await BSW.connect(acc1Signer).approve(vBSW.address, bswBorrowAmount);
  });
  it("generate bad Debt, reserves transfer to protocol share reserves, start auction", async function () {
  //Increase price of borrowed underlying tokens to surpass available collateral
  const dummyPriceOracle = await smock.fake<PriceOracle>("PriceOracle");
  dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBSW.address).returns(convertToUnit("1", 20));
  dummyPriceOracle.getUnderlyingPrice.whenCalledWith(vBNX.address).returns(convertToUnit("1", 15));
  await Comptroller.setPriceOracle(dummyPriceOracle.address);
  
  await Comptroller.connect(acc1Signer).healAccount(acc2);
  //At this point market contain bad debt
  const totalReserves = await vBNX.totalReserves();
  //Reserves of the market are being transferred to protocol share reserves
  await vBNX.reduceReserves(totalReserves);
  //Check the balance of protocol share reserve
  expect(await BNX.balanceOf(ProtocolShareReserve.address)).to.be.equal(totalReserves);
  
  //Reduce reserves, transfer 70% to protocol income and rest 30% to riskFund
  // await ProtocolShareReserve.connect(deployerSigner).releaseFunds(Comptroller.address, BNX.address, totalReserves);
  });
  });
  });