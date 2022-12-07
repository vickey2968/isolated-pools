import { FakeContract, smock } from "@defi-wonderland/smock";
import { impersonateAccount, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { constants } from "ethers";
import { ethers, upgrades } from "hardhat";

import { convertToUnit } from "../../../helpers/utils";
import {
  AccessControlManager,
  Beacon,
  Comptroller,
  JumpRateModelFactory,
  MockPriceOracle,
  MockToken,
  MockToken__factory,
  PancakeRouter,
  PancakeRouter__factory,
  PoolRegistry,
  ProtocolShareReserve,
  RiskFund,
  VToken,
  VTokenProxyFactory,
  WhitePaperInterestRateModelFactory,
} from "../../../typechain";

let poolRegistry: PoolRegistry;
let comptrollerBeacon: Beacon;
let vTokenBeacon: Beacon;
let USDC: MockToken;
let BUSD: MockToken;
let USDT: MockToken;
let cUSDC: VToken;
let cUSDT: VToken;
let cUSDC2: VToken;
let cUSDT2: VToken;
let cUSDT3: VToken;
let bUSDT3: VToken;
let priceOracle: MockPriceOracle;
let comptroller1Proxy: Comptroller;
let comptroller2Proxy: Comptroller;
let comptroller3Proxy: Comptroller;
let vTokenFactory: VTokenProxyFactory;
let jumpRateFactory: JumpRateModelFactory;
let whitePaperRateFactory: WhitePaperInterestRateModelFactory;
let accessControlManager: AccessControlManager;
let protocolShareReserve: ProtocolShareReserve;
let riskFund: RiskFund;
let pancakeSwapRouter: PancakeRouter | FakeContract<PancakeRouter>;
let busdUser: any;
let usdcUser: any;
let usdtUser: any;

const FORK_MAINNET = process.env.FORK_MAINNET === "true";
const someNonzeroAddress = "0x0000000000000000000000000000000000000001";

const initPancakeSwapRouter = async (
  admin: SignerWithAddress,
): Promise<PancakeRouter | FakeContract<PancakeRouter>> => {
  let pancakeSwapRouter: PancakeRouter | FakeContract<PancakeRouter>;
  if (FORK_MAINNET) {
    pancakeSwapRouter = PancakeRouter__factory.connect("0x10ED43C718714eb63d5aA57B78B54704E256024E", admin);
  } else {
    const pancakeSwapRouterFactory = await smock.mock<PancakeRouter__factory>("PancakeRouter");
    pancakeSwapRouter = await pancakeSwapRouterFactory.deploy(
      "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      admin.address,
    );
    await pancakeSwapRouter.deployed();
    const pancakeRouterSigner = await ethers.getSigner(pancakeSwapRouter.address);
    // Send some BNB to account so it can faucet money from mock tokens
    const tx = await admin.sendTransaction({
      to: pancakeSwapRouter.address,
      value: ethers.utils.parseEther("10"),
    });
    await tx.wait();
    await USDC.connect(pancakeRouterSigner).faucet(convertToUnit(1000000, 18));
    await USDT.connect(pancakeRouterSigner).faucet(convertToUnit(1000000, 18));
    await BUSD.connect(pancakeRouterSigner).faucet(convertToUnit(1000000, 18));
  }
  return pancakeSwapRouter;
};

const initMainnetUser = async (user: string) => {
  await impersonateAccount(user);
  return ethers.getSigner(user);
};

const initMockToken = async (name: string, symbol: string, user: SignerWithAddress): Promise<MockToken> => {
  const MockToken = await ethers.getContractFactory("MockToken");
  const token = await MockToken.deploy(name, symbol, 18);
  await token.deployed();
  await token.faucet(convertToUnit(1000000, 18));
  await token.transfer(user.address, convertToUnit(1000000, 18));
  return token;
};

const riskFundFixture = async (): Promise<void> => {
  const [admin, user, proxyAdmin, ...signers] = await ethers.getSigners();
  if (FORK_MAINNET) {
    busdUser = await initMainnetUser("0xFd2FB1D2f41347527492656aD76E86820e5735F2");
    usdcUser = await initMainnetUser("0x64f87BCa71227b97D2762907871E8188b4B1DddF");
    usdtUser = await initMainnetUser("0xE4FEb3e94B4128d973A366dc4814167a90629A08");

    USDC = MockToken__factory.connect("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", user);
    BUSD = MockToken__factory.connect("0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", user);
    USDT = MockToken__factory.connect("0x55d398326f99059fF775485246999027B3197955", user);
  } else {
    [busdUser, usdcUser, usdtUser] = signers;

    USDC = await initMockToken("Mock USDC", "USDC", usdcUser);
    BUSD = await initMockToken("Mock BUSD", "BUSD", busdUser);
    USDT = await initMockToken("Mock USDT", "USDT", usdtUser);
  }

  const VTokenProxyFactory = await ethers.getContractFactory("VTokenProxyFactory");
  vTokenFactory = await VTokenProxyFactory.deploy();
  await vTokenFactory.deployed();

  const JumpRateModelFactory = await ethers.getContractFactory("JumpRateModelFactory");
  jumpRateFactory = await JumpRateModelFactory.deploy();
  await jumpRateFactory.deployed();

  const WhitePaperInterestRateModelFactory = await ethers.getContractFactory("WhitePaperInterestRateModelFactory");
  whitePaperRateFactory = await WhitePaperInterestRateModelFactory.deploy();
  await whitePaperRateFactory.deployed();

  pancakeSwapRouter = await initPancakeSwapRouter(admin);

  const AccessControlManagerFactory = await ethers.getContractFactory("AccessControlManager");
  accessControlManager = await AccessControlManagerFactory.deploy();
  await accessControlManager.deployed();

  const RiskFund = await ethers.getContractFactory("RiskFund");
  riskFund = await upgrades.deployProxy(RiskFund, [
    pancakeSwapRouter.address,
    convertToUnit(10, 18),
    convertToUnit(10, 18),
    BUSD.address,
    accessControlManager.address,
  ]);

  const fakeProtocolIncome = await smock.fake<RiskFund>("RiskFund");
  const ProtocolShareReserve = await ethers.getContractFactory("ProtocolShareReserve");
  protocolShareReserve = await upgrades.deployProxy(ProtocolShareReserve, [
    fakeProtocolIncome.address,
    riskFund.address,
  ]);

  const Shortfall = await ethers.getContractFactory("Shortfall");
  const shortfall = await upgrades.deployProxy(Shortfall, [
    ethers.constants.AddressZero,
    ethers.constants.AddressZero,
    convertToUnit("10000", 18),
  ]);

  const PoolRegistry = await ethers.getContractFactory("PoolRegistry");
  poolRegistry = await upgrades.deployProxy(PoolRegistry, [
    vTokenFactory.address,
    jumpRateFactory.address,
    whitePaperRateFactory.address,
    shortfall.address,
    riskFund.address,
    protocolShareReserve.address,
  ]);

  await accessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "setCollateralFactor(address,uint256,uint256)",
    poolRegistry.address,
  );

  await accessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "setLiquidationIncentive(uint256)",
    poolRegistry.address,
  );

  await accessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "setMinLiquidatableCollateral(uint256)",
    poolRegistry.address,
  );

  await accessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "supportMarket(address)",
    poolRegistry.address,
  );

  await accessControlManager.giveCallPermission(ethers.constants.AddressZero, "swapAllPoolsAssets()", admin.address);

  await shortfall.setPoolRegistry(poolRegistry.address);

  const Comptroller = await ethers.getContractFactory("Comptroller");
  const comptroller = await Comptroller.deploy(poolRegistry.address, accessControlManager.address);
  await comptroller.deployed();

  const VTokenContract = await ethers.getContractFactory("VToken");
  const vToken = await VTokenContract.deploy();
  await vToken.deployed();

  const ComptrollerBeacon = await ethers.getContractFactory("Beacon");
  comptrollerBeacon = await ComptrollerBeacon.deploy(comptroller.address);
  await comptrollerBeacon.deployed();

  const VTokenBeacon = await ethers.getContractFactory("Beacon");
  vTokenBeacon = await VTokenBeacon.deploy(vToken.address);
  await vTokenBeacon.deployed();

  const _closeFactor = convertToUnit(0.05, 18);
  const _liquidationIncentive = convertToUnit(1, 18);
  const _minLiquidatableCollateral = convertToUnit(100, 18);

  // Deploy Price Oracle
  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  priceOracle = await MockPriceOracle.deploy();

  const usdtPrice = ".75";
  const usdcPrice = "1";
  const busdPrice = "1.1";

  await priceOracle.setPrice(USDC.address, convertToUnit(usdcPrice, 18));
  await priceOracle.setPrice(USDT.address, convertToUnit(usdtPrice, 18));
  await priceOracle.setPrice(BUSD.address, convertToUnit(busdPrice, 18));

  // Registering the first pool
  await poolRegistry.createRegistryPool(
    "Pool 1",
    comptrollerBeacon.address,
    _closeFactor,
    _liquidationIncentive,
    _minLiquidatableCollateral,
    priceOracle.address,
  );

  // Registering the second pool
  await poolRegistry.createRegistryPool(
    "Pool 2",
    comptrollerBeacon.address,
    _closeFactor,
    _liquidationIncentive,
    _minLiquidatableCollateral,
    priceOracle.address,
  );

  // Registering the third pool
  await poolRegistry.createRegistryPool(
    "Pool 3",
    comptrollerBeacon.address,
    _closeFactor,
    _liquidationIncentive,
    _minLiquidatableCollateral,
    priceOracle.address,
  );

  // Setup Proxies
  const pools = await poolRegistry.callStatic.getAllPools();
  comptroller1Proxy = await ethers.getContractAt("Comptroller", pools[0].comptroller);
  await comptroller1Proxy.acceptOwnership();

  await accessControlManager.giveCallPermission(
    ethers.constants.AddressZero,
    "transferReserveForAuction(address,uint256)",
    admin.address,
  );

  comptroller2Proxy = await ethers.getContractAt("Comptroller", pools[1].comptroller);
  await comptroller2Proxy.acceptOwnership();

  comptroller3Proxy = await ethers.getContractAt("Comptroller", pools[2].comptroller);
  await comptroller3Proxy.acceptOwnership();

  const VToken = await ethers.getContractFactory("VToken");
  const tokenImplementation = await VToken.deploy();
  await tokenImplementation.deployed();

  // Deploy CTokens
  await poolRegistry.addMarket({
    comptroller: comptroller1Proxy.address,
    asset: USDT.address,
    decimals: 8,
    name: "Compound USDT",
    symbol: "cUSDT",
    rateModel: 0,
    baseRatePerYear: 0,
    multiplierPerYear: "40000000000000000",
    jumpMultiplierPerYear: 0,
    kink_: 0,
    collateralFactor: convertToUnit(0.7, 18),
    liquidationThreshold: convertToUnit(0.7, 18),
    accessControlManager: accessControlManager.address,
    vTokenProxyAdmin: proxyAdmin.address,
    beaconAddress: vTokenBeacon.address,
  });

  await poolRegistry.addMarket({
    comptroller: comptroller1Proxy.address,
    asset: USDC.address,
    decimals: 18,
    name: "Compound USDC",
    symbol: "cUSDC",
    rateModel: 0,
    baseRatePerYear: 0,
    multiplierPerYear: "40000000000000000",
    jumpMultiplierPerYear: 0,
    kink_: 0,
    collateralFactor: convertToUnit(0.7, 18),
    liquidationThreshold: convertToUnit(0.7, 18),
    accessControlManager: accessControlManager.address,
    vTokenProxyAdmin: proxyAdmin.address,
    beaconAddress: vTokenBeacon.address,
  });

  await poolRegistry.addMarket({
    comptroller: comptroller2Proxy.address,
    asset: USDT.address,
    decimals: 8,
    name: "Compound USDT",
    symbol: "cUSDT",
    rateModel: 0,
    baseRatePerYear: 0,
    multiplierPerYear: "40000000000000000",
    jumpMultiplierPerYear: 0,
    kink_: 0,
    collateralFactor: convertToUnit(0.7, 18),
    liquidationThreshold: convertToUnit(0.7, 18),
    accessControlManager: accessControlManager.address,
    vTokenProxyAdmin: proxyAdmin.address,
    beaconAddress: vTokenBeacon.address,
  });

  await poolRegistry.addMarket({
    comptroller: comptroller2Proxy.address,
    asset: USDC.address,
    decimals: 18,
    name: "Compound USDC",
    symbol: "cUSDC",
    rateModel: 0,
    baseRatePerYear: 0,
    multiplierPerYear: "40000000000000000",
    jumpMultiplierPerYear: 0,
    kink_: 0,
    collateralFactor: convertToUnit(0.7, 18),
    liquidationThreshold: convertToUnit(0.7, 18),
    accessControlManager: accessControlManager.address,
    vTokenProxyAdmin: proxyAdmin.address,
    beaconAddress: vTokenBeacon.address,
  });

  await poolRegistry.addMarket({
    comptroller: comptroller3Proxy.address,
    asset: USDT.address,
    decimals: 8,
    name: "Compound USDT",
    symbol: "cUSDT",
    rateModel: 0,
    baseRatePerYear: 0,
    multiplierPerYear: "40000000000000000",
    jumpMultiplierPerYear: 0,
    kink_: 0,
    collateralFactor: convertToUnit(0.7, 18),
    liquidationThreshold: convertToUnit(0.7, 18),
    accessControlManager: accessControlManager.address,
    vTokenProxyAdmin: proxyAdmin.address,
    beaconAddress: vTokenBeacon.address,
  });

  await poolRegistry.addMarket({
    comptroller: comptroller3Proxy.address,
    asset: BUSD.address,
    decimals: 8,
    name: "BUSDT",
    symbol: "bUSDT",
    rateModel: 0,
    baseRatePerYear: 0,
    multiplierPerYear: "40000000000000000",
    jumpMultiplierPerYear: 0,
    kink_: 0,
    collateralFactor: convertToUnit(0.7, 18),
    liquidationThreshold: convertToUnit(0.7, 18),
    accessControlManager: accessControlManager.address,
    vTokenProxyAdmin: proxyAdmin.address,
    beaconAddress: vTokenBeacon.address,
  });

  const cUSDT1Address = await poolRegistry.getVTokenForAsset(comptroller1Proxy.address, USDT.address);

  const cUSDC1Address = await poolRegistry.getVTokenForAsset(comptroller1Proxy.address, USDC.address);

  const cUSDT2Address = await poolRegistry.getVTokenForAsset(comptroller2Proxy.address, USDT.address);

  const cUSDC2Address = await poolRegistry.getVTokenForAsset(comptroller2Proxy.address, USDC.address);

  const cUSDT3Address = await poolRegistry.getVTokenForAsset(comptroller3Proxy.address, USDT.address);

  const bUSDT3Address = await poolRegistry.getVTokenForAsset(comptroller3Proxy.address, BUSD.address);

  cUSDT = await ethers.getContractAt("VToken", cUSDT1Address);
  cUSDC = await ethers.getContractAt("VToken", cUSDC1Address);
  cUSDT2 = await ethers.getContractAt("VToken", cUSDT2Address);
  cUSDC2 = await ethers.getContractAt("VToken", cUSDC2Address);
  cUSDT3 = await ethers.getContractAt("VToken", cUSDT3Address);
  bUSDT3 = await ethers.getContractAt("VToken", bUSDT3Address);

  // Enter Markets

  await comptroller1Proxy.connect(user).enterMarkets([cUSDC.address, cUSDT.address]);

  await comptroller2Proxy.connect(user).enterMarkets([cUSDC2.address, cUSDT2.address]);

  await comptroller3Proxy.connect(user).enterMarkets([cUSDT3.address, bUSDT3.address]);

  // Set Oracle
  await comptroller1Proxy.setPriceOracle(priceOracle.address);
  await comptroller2Proxy.setPriceOracle(priceOracle.address);
  await comptroller3Proxy.setPriceOracle(priceOracle.address);

  await riskFund.setPoolRegistry(poolRegistry.address);
};

describe("Risk Fund: Tests", function () {
  /**
   * Deploying required contracts along with the poolRegistry.
   */

  beforeEach(async function () {
    await loadFixture(riskFundFixture);
  });

  describe("Test all setters", async function () {
    describe("setPoolRegistry", async function () {
      it("reverts on invalid PoolRegistry address", async function () {
        await expect(riskFund.setPoolRegistry(constants.AddressZero)).to.be.rejectedWith(
          "Risk Fund: Pool registry address invalid",
        );
      });

      it("fails if called by a non-owner", async function () {
        await expect(riskFund.connect(usdcUser).setPoolRegistry(poolRegistry.address)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits PoolRegistryUpdated event", async function () {
        const newPoolRegistry = await smock.fake<PoolRegistry>("PoolRegistry");
        const tx = riskFund.setPoolRegistry(newPoolRegistry.address);
        await expect(tx)
          .to.emit(riskFund, "PoolRegistryUpdated")
          .withArgs(poolRegistry.address, newPoolRegistry.address);
      });
    });

    describe("setConvertableBaseAsset", async function () {
      it("Reverts on invalid Pool registry address", async function () {
        await expect(riskFund.setConvertableBaseAsset(constants.AddressZero)).to.be.rejectedWith(
          "Risk Fund: Asset address invalid",
        );
      });

      it("fails if called by a non-owner", async function () {
        await expect(riskFund.connect(usdcUser).setConvertableBaseAsset(BUSD.address)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits ConvertableBaseAssetUpdated event", async function () {
        const newBaseAsset = await smock.fake<MockToken>("PoolRegistry");
        const tx = riskFund.setConvertableBaseAsset(newBaseAsset.address);
        await expect(tx).to.emit(riskFund, "ConvertableBaseAssetUpdated").withArgs(BUSD.address, newBaseAsset.address);
      });
    });

    describe("setAuctionContractAddress", async function () {
      it("Reverts on invalid Auction contract address", async function () {
        await expect(riskFund.setAuctionContractAddress(constants.AddressZero)).to.be.rejectedWith(
          "Risk Fund: Auction contract address invalid",
        );
      });

      it("fails if called by a non-owner", async function () {
        await expect(riskFund.connect(usdcUser).setAuctionContractAddress(someNonzeroAddress)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits AuctionContractUpdated event", async function () {
        const tx = riskFund.setAuctionContractAddress(someNonzeroAddress);
        await expect(tx)
          .to.emit(riskFund, "AuctionContractUpdated")
          .withArgs(constants.AddressZero, someNonzeroAddress);
      });
    });

    describe("setPancakeSwapRouter", async function () {
      it("Reverts on invalid PancakeSwap router contract address", async function () {
        await expect(riskFund.setPancakeSwapRouter(constants.AddressZero)).to.be.rejectedWith(
          "Risk Fund: PancakeSwap address invalid",
        );
      });

      it("fails if called by a non-owner", async function () {
        await expect(riskFund.connect(usdcUser).setPancakeSwapRouter(someNonzeroAddress)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits PancakeSwapRouterUpdated event", async function () {
        const tx = riskFund.setPancakeSwapRouter(someNonzeroAddress);
        await expect(tx)
          .to.emit(riskFund, "PancakeSwapRouterUpdated")
          .withArgs(pancakeSwapRouter.address, someNonzeroAddress);
      });
    });

    describe("setAmountOutMin", async function () {
      it("fails if called by a non-owner", async function () {
        await expect(riskFund.connect(usdcUser).setAmountOutMin(1)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits AmountOutMinUpdated event", async function () {
        const tx = riskFund.setAmountOutMin(1);
        await expect(tx).to.emit(riskFund, "AmountOutMinUpdated").withArgs(convertToUnit(10, 18), 1);
      });
    });

    describe("setMinAmountToConvert", async function () {
      it("reverts on invalid min amount to convert", async function () {
        await expect(riskFund.setMinAmountToConvert(0)).to.be.rejectedWith("Risk Fund: Invalid min amout to convert");
      });

      it("fails if called by a non-owner", async function () {
        await expect(riskFund.connect(usdcUser).setMinAmountToConvert(1)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits MinAmountToConvertUpdated event", async function () {
        const tx = riskFund.setMinAmountToConvert(1);
        await expect(tx).to.emit(riskFund, "MinAmountToConvertUpdated").withArgs(convertToUnit(10, 18), 1);
      });
    });
  });

  describe("Risk fund transfers", async function () {
    it("Checks access control", async function () {
      const [admin] = await ethers.getSigners();
      // Revoke
      await accessControlManager.revokeCallPermission(
        ethers.constants.AddressZero,
        "swapAllPoolsAssets()",
        admin.address,
      );
      // Fails
      await expect(riskFund.swapAllPoolsAssets()).to.be.rejectedWith("Risk fund: Not authorized to swap pool assets.");

      // Reset
      await accessControlManager.giveCallPermission(
        ethers.constants.AddressZero,
        "swapAllPoolsAssets()",
        admin.address,
      );
      // Succeeds
      await riskFund.swapAllPoolsAssets();
    });

    it("Convert to BUSD without funds", async function () {
      const amount = await riskFund.callStatic.swapAllPoolsAssets();
      expect(amount).equal("0");
    });

    it("Below min threshold amount", async function () {
      await USDC.connect(usdcUser).approve(cUSDC.address, convertToUnit(1000, 18));

      await cUSDC.connect(usdcUser).addReserves(convertToUnit(200, 18));

      await cUSDC.reduceReserves(convertToUnit(50, 18));

      const protocolReserveUSDCBal = await USDC.balanceOf(protocolShareReserve.address);
      expect(protocolReserveUSDCBal).equal(convertToUnit(50, 18));
      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDC.address, convertToUnit(30, 18));
      const riskFundUSDCBal = await USDC.balanceOf(riskFund.address);
      expect(riskFundUSDCBal).equal(convertToUnit(9, 18));

      const amount = await riskFund.callStatic.swapAllPoolsAssets();
      expect(amount).equal("0");
    });

    it("Above min threshold amount", async function () {
      await USDC.connect(usdcUser).approve(cUSDC.address, convertToUnit(1000, 18));

      await cUSDC.connect(usdcUser).addReserves(convertToUnit(200, 18));
      await cUSDC.reduceReserves(convertToUnit(100, 18));

      const protocolReserveUSDCBal = await USDC.balanceOf(protocolShareReserve.address);
      expect(protocolReserveUSDCBal).equal(convertToUnit(100, 18));

      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDC.address, convertToUnit(100, 18));
      const riskFundUSDCBal = await USDC.balanceOf(riskFund.address);
      expect(riskFundUSDCBal).equal(convertToUnit(30, 18));

      await riskFund.swapAllPoolsAssets();
      const balanceAfter = await USDC.balanceOf(riskFund.address);
      expect(balanceAfter).equal("0");

      const balanceBUSD = await BUSD.balanceOf(riskFund.address);
      expect(Number(balanceBUSD)).to.be.closeTo(Number(convertToUnit(30, 18)), Number(convertToUnit(3, 17)));
    });

    it("Add two assets to riskFund", async function () {
      await USDC.connect(usdcUser).approve(cUSDC.address, convertToUnit(1000, 18));

      await cUSDC.connect(usdcUser).addReserves(convertToUnit(200, 18));

      await USDT.connect(usdtUser).approve(cUSDT.address, convertToUnit(1000, 18));

      await cUSDT.connect(usdtUser).addReserves(convertToUnit(200, 18));

      await cUSDT.reduceReserves(convertToUnit(100, 18));
      await cUSDC.reduceReserves(convertToUnit(100, 18));

      const protocolReserveUSDCBal = await USDC.balanceOf(protocolShareReserve.address);
      expect(protocolReserveUSDCBal).equal(convertToUnit(100, 18));

      const protocolReserveUSDTBal = await USDT.balanceOf(protocolShareReserve.address);
      expect(protocolReserveUSDTBal).equal(convertToUnit(100, 18));

      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDC.address, convertToUnit(100, 18));
      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDT.address, convertToUnit(100, 18));
      const riskFundUSDCBal = await USDC.balanceOf(riskFund.address);
      expect(riskFundUSDCBal).equal(convertToUnit(30, 18));

      const riskFundUSDTBal = await USDT.balanceOf(riskFund.address);
      expect(riskFundUSDTBal).equal(convertToUnit(30, 18));

      await riskFund.swapAllPoolsAssets();
      const balanceBUSD = await BUSD.balanceOf(riskFund.address);
      expect(Number(balanceBUSD)).to.be.closeTo(Number(convertToUnit(60, 18)), Number(convertToUnit(3, 17)));

      const pool1Reserve = await riskFund.getPoolReserve(comptroller1Proxy.address);
      const pool2Reserve = await riskFund.getPoolReserve("0x0000000000000000000000000000000000000000");
      expect(Number(pool1Reserve)).to.be.closeTo(Number(convertToUnit(60, 18)), Number(convertToUnit(3, 17)));
      expect(pool2Reserve).equal(0);
    });
  });

  describe("Transfer to Auction contract", async function () {
    it("Revert while transfering funds to Auction contract", async function () {
      await expect(
        riskFund.transferReserveForAuction(comptroller1Proxy.address, convertToUnit(30, 18)),
      ).to.be.rejectedWith("Risk Fund: Auction contract invalid address.");

      const auctionContract = "0x0000000000000000000000000000000000000001";
      await riskFund.setAuctionContractAddress(auctionContract);

      await expect(
        riskFund.transferReserveForAuction(comptroller1Proxy.address, convertToUnit(100, 18)),
      ).to.be.rejectedWith("Risk Fund: Insufficient pool reserve.");
    });

    it("Transfer funds to auction contact", async function () {
      const auctionContract = "0x0000000000000000000000000000000000000001";
      await riskFund.setAuctionContractAddress(auctionContract);

      await USDC.connect(usdcUser).approve(cUSDC.address, convertToUnit(1000, 18));

      await cUSDC.connect(usdcUser).addReserves(convertToUnit(200, 18));

      await USDT.connect(usdtUser).approve(cUSDT.address, convertToUnit(1000, 18));

      await cUSDT.connect(usdtUser).addReserves(convertToUnit(200, 18));

      await cUSDT.reduceReserves(convertToUnit(100, 18));
      await cUSDC.reduceReserves(convertToUnit(100, 18));
      const protocolReserveUSDCBal = await USDC.balanceOf(protocolShareReserve.address);
      expect(protocolReserveUSDCBal).equal(convertToUnit(100, 18));

      const protocolReserveUSDTBal = await USDT.balanceOf(protocolShareReserve.address);
      expect(protocolReserveUSDTBal).equal(convertToUnit(100, 18));

      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDC.address, convertToUnit(100, 18));
      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDT.address, convertToUnit(100, 18));
      await riskFund.swapAllPoolsAssets();

      const beforeTransfer = await BUSD.balanceOf(auctionContract);
      await riskFund.transferReserveForAuction(comptroller1Proxy.address, convertToUnit(20, 18));
      const afterTransfer = await BUSD.balanceOf(auctionContract);
      const remainingBalance = await BUSD.balanceOf(riskFund.address);
      const poolReserve = await riskFund.getPoolReserve(comptroller1Proxy.address);

      const amount = Number(afterTransfer) - Number(beforeTransfer);
      expect(amount).to.be.closeTo(Number(convertToUnit(20, 18)), Number(convertToUnit(3, 17)));
      expect(remainingBalance).equal(poolReserve);
    });

    it("Should revert the transfer to auction transaction", async function () {
      const [admin] = await ethers.getSigners();
      const auctionContract = "0x0000000000000000000000000000000000000001";
      await riskFund.setAuctionContractAddress(auctionContract);

      await USDC.connect(usdcUser).approve(cUSDC.address, convertToUnit(1000, 18));

      await cUSDC.connect(usdcUser).addReserves(convertToUnit(200, 18));

      await USDT.connect(usdtUser).approve(cUSDT.address, convertToUnit(1000, 18));

      await cUSDT.connect(usdtUser).addReserves(convertToUnit(200, 18));

      await cUSDT.reduceReserves(convertToUnit(100, 18));
      await cUSDC.reduceReserves(convertToUnit(100, 18));
      await riskFund.swapAllPoolsAssets();

      // revoke
      await accessControlManager.revokeCallPermission(
        ethers.constants.AddressZero,
        "transferReserveForAuction(address,uint256)",
        admin.address,
      );

      await expect(
        riskFund.transferReserveForAuction(comptroller1Proxy.address, convertToUnit(20, 18)),
      ).to.be.rejectedWith("Risk fund: Not authorized to transfer funds.");

      // reset
      await accessControlManager.giveCallPermission(
        ethers.constants.AddressZero,
        "transferReserveForAuction(address,uint256)",
        admin.address,
      );
    });

    it("Transfer single asset from multiple pools to riskFund.", async function () {
      const auctionContract = "0x0000000000000000000000000000000000000001";
      await riskFund.setAuctionContractAddress(auctionContract);

      await USDC.connect(usdcUser).approve(cUSDC.address, convertToUnit(1000, 18));

      await cUSDC.connect(usdcUser).addReserves(convertToUnit(200, 18));

      await USDT.connect(usdtUser).approve(cUSDT.address, convertToUnit(1000, 18));

      await cUSDT.connect(usdtUser).addReserves(convertToUnit(200, 18));

      await USDC.connect(usdcUser).approve(cUSDC2.address, convertToUnit(1000, 18));

      await cUSDC2.connect(usdcUser).addReserves(convertToUnit(200, 18));

      await USDT.connect(usdtUser).approve(cUSDT2.address, convertToUnit(1000, 18));

      await cUSDT2.connect(usdtUser).addReserves(convertToUnit(200, 18));

      await USDT.connect(usdtUser).approve(cUSDT3.address, convertToUnit(1000, 18));

      await cUSDT3.connect(usdtUser).addReserves(convertToUnit(200, 18));

      await BUSD.connect(busdUser).approve(bUSDT3.address, convertToUnit(1000, 18));

      await bUSDT3.connect(busdUser).addReserves(convertToUnit(50, 18));

      await cUSDT.reduceReserves(convertToUnit(110, 18));
      await cUSDC.reduceReserves(convertToUnit(120, 18));
      await cUSDT2.reduceReserves(convertToUnit(150, 18));
      await cUSDC2.reduceReserves(convertToUnit(160, 18));
      await cUSDT3.reduceReserves(convertToUnit(175, 18));
      await bUSDT3.reduceReserves(convertToUnit(50, 18));

      let protocolUSDTFor1 = await protocolShareReserve.getPoolAssetReserve(comptroller1Proxy.address, USDT.address);
      let protocolUSDCFor1 = await protocolShareReserve.getPoolAssetReserve(comptroller1Proxy.address, USDC.address);
      let protocolUSDTFor2 = await protocolShareReserve.getPoolAssetReserve(comptroller2Proxy.address, USDT.address);
      let protocolUSDCFor2 = await protocolShareReserve.getPoolAssetReserve(comptroller2Proxy.address, USDC.address);
      let protocolUSDTFor3 = await protocolShareReserve.getPoolAssetReserve(comptroller3Proxy.address, USDT.address);
      let protocolBUSDTFor3 = await protocolShareReserve.getPoolAssetReserve(comptroller3Proxy.address, BUSD.address);

      expect(protocolUSDTFor1).equal(convertToUnit(110, 18));
      expect(protocolUSDTFor2).equal(convertToUnit(150, 18));
      expect(protocolUSDTFor3).equal(convertToUnit(175, 18));
      expect(protocolUSDCFor1).equal(convertToUnit(120, 18));
      expect(protocolUSDCFor2).equal(convertToUnit(160, 18));
      expect(protocolBUSDTFor3).equal(convertToUnit(50, 18));

      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDT.address, convertToUnit(100, 18));

      await protocolShareReserve.releaseFunds(comptroller2Proxy.address, USDT.address, convertToUnit(110, 18));

      await protocolShareReserve.releaseFunds(comptroller3Proxy.address, USDT.address, convertToUnit(130, 18));

      await protocolShareReserve.releaseFunds(comptroller1Proxy.address, USDC.address, convertToUnit(90, 18));

      await protocolShareReserve.releaseFunds(comptroller2Proxy.address, USDC.address, convertToUnit(80, 18));

      await protocolShareReserve.releaseFunds(comptroller3Proxy.address, BUSD.address, convertToUnit(50, 18));

      protocolUSDTFor1 = await protocolShareReserve.getPoolAssetReserve(comptroller1Proxy.address, USDT.address);
      protocolUSDCFor1 = await protocolShareReserve.getPoolAssetReserve(comptroller1Proxy.address, USDC.address);
      protocolUSDTFor2 = await protocolShareReserve.getPoolAssetReserve(comptroller2Proxy.address, USDT.address);
      protocolUSDCFor2 = await protocolShareReserve.getPoolAssetReserve(comptroller2Proxy.address, USDC.address);
      protocolUSDTFor3 = await protocolShareReserve.getPoolAssetReserve(comptroller3Proxy.address, USDT.address);
      protocolBUSDTFor3 = await protocolShareReserve.getPoolAssetReserve(comptroller3Proxy.address, BUSD.address);

      expect(protocolUSDTFor1).equal(convertToUnit(10, 18));
      expect(protocolUSDTFor2).equal(convertToUnit(40, 18));
      expect(protocolUSDTFor3).equal(convertToUnit(45, 18));
      expect(protocolUSDCFor1).equal(convertToUnit(30, 18));
      expect(protocolUSDCFor2).equal(convertToUnit(80, 18));
      expect(protocolBUSDTFor3).equal(convertToUnit(0, 18));

      let riskUSDTFor1 = await riskFund.getPoolAssetReserve(comptroller1Proxy.address, USDT.address);
      let riskUSDCFor1 = await riskFund.getPoolAssetReserve(comptroller1Proxy.address, USDC.address);
      let riskUSDTFor2 = await riskFund.getPoolAssetReserve(comptroller2Proxy.address, USDT.address);
      let riskUSDCFor2 = await riskFund.getPoolAssetReserve(comptroller2Proxy.address, USDC.address);
      let riskUSDTFor3 = await riskFund.getPoolAssetReserve(comptroller3Proxy.address, USDT.address);
      let riskBUSDTFor3 = await riskFund.getPoolAssetReserve(comptroller3Proxy.address, BUSD.address);

      expect(riskUSDTFor1).equal(convertToUnit(30, 18));
      expect(riskUSDCFor1).equal(convertToUnit(27, 18));
      expect(riskUSDTFor2).equal(convertToUnit(33, 18));
      expect(riskUSDCFor2).equal(convertToUnit(24, 18));
      expect(riskUSDTFor3).equal(convertToUnit(39, 18));
      expect(riskBUSDTFor3).equal(convertToUnit(15, 18));

      await riskFund.swapAllPoolsAssets();

      riskUSDTFor1 = await riskFund.getPoolAssetReserve(comptroller1Proxy.address, USDT.address);
      riskUSDCFor1 = await riskFund.getPoolAssetReserve(comptroller1Proxy.address, USDC.address);
      riskUSDTFor2 = await riskFund.getPoolAssetReserve(comptroller2Proxy.address, USDT.address);
      riskUSDCFor2 = await riskFund.getPoolAssetReserve(comptroller2Proxy.address, USDC.address);
      riskUSDTFor3 = await riskFund.getPoolAssetReserve(comptroller3Proxy.address, USDT.address);
      riskBUSDTFor3 = await riskFund.getPoolAssetReserve(comptroller3Proxy.address, BUSD.address);

      expect(riskUSDTFor1).equal(0);
      expect(riskUSDCFor1).equal(0);
      expect(riskUSDTFor2).equal(0);
      expect(riskUSDCFor2).equal(0);
      expect(riskUSDTFor3).equal(0);
      expect(riskBUSDTFor3).equal(0);

      const poolReserve1 = await riskFund.getPoolReserve(comptroller1Proxy.address);

      const poolReserve2 = await riskFund.getPoolReserve(comptroller2Proxy.address);

      const poolReserve3 = await riskFund.getPoolReserve(comptroller3Proxy.address);

      expect(poolReserve1).to.be.closeTo(convertToUnit(56, 18), convertToUnit(9, 17));
      expect(poolReserve2).to.be.closeTo(convertToUnit(56, 18), convertToUnit(9, 17));
      expect(poolReserve3).to.be.closeTo(convertToUnit(53, 18), convertToUnit(9, 17));
    });
  });
});
