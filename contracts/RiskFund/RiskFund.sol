// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.13;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";

import { IRiskFund } from "./IRiskFund.sol";
import { ReserveHelpers } from "./ReserveHelpers.sol";
import { ExponentialNoError } from "../ExponentialNoError.sol";
import { VToken } from "../VToken.sol";
import { ComptrollerViewInterface } from "../ComptrollerInterface.sol";
import { Comptroller } from "../Comptroller.sol";
import { PoolRegistry } from "../Pool/PoolRegistry.sol";
import { IPancakeswapV2Router } from "../IPancakeswapV2Router.sol";
import { IShortfall } from "../Shortfall/IShortfall.sol";
import { MaxLoopsLimitHelper } from "../MaxLoopsLimitHelper.sol";
import { ensureNonzeroAddress } from "../lib/validators.sol";

/**
 * @dev This contract does not support BNB.
 */
contract RiskFund is
    Ownable2StepUpgradeable,
    AccessControlledV8,
    ExponentialNoError,
    ReserveHelpers,
    MaxLoopsLimitHelper,
    IRiskFund
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    address private pancakeSwapRouter;
    uint256 private minAmountToConvert;
    address private convertibleBaseAsset;
    address private shortfall;

    // Store base asset's reserve for specific pool
    mapping(address => uint256) public poolReserves;

    /// @notice Emitted when pool registry address is updated
    event PoolRegistryUpdated(address indexed oldPoolRegistry, address indexed newPoolRegistry);

    /// @notice Emitted when shortfall contract address is updated
    event ShortfallContractUpdated(address indexed oldShortfallContract, address indexed newShortfallContract);

    /// @notice Emitted when PancakeSwap router contract address is updated
    event PancakeSwapRouterUpdated(address indexed oldPancakeSwapRouter, address indexed newPancakeSwapRouter);

    /// @notice Emitted when min amount out for PancakeSwap is updated
    event AmountOutMinUpdated(uint256 oldAmountOutMin, uint256 newAmountOutMin);

    /// @notice Emitted when minimum amount to convert is updated
    event MinAmountToConvertUpdated(uint256 oldMinAmountToConvert, uint256 newMinAmountToConvert);

    /// @notice Emitted when pools assets are swapped
    event SwappedPoolsAssets(address[] markets, uint256[] amountsOutMin, uint256 totalAmount);

    /// @notice Emitted when reserves are transferred for auction
    event TransferredReserveForAuction(address comptroller, uint256 amount);

    /// @dev Note that the contract is upgradeable. Use initialize() or reinitializers
    ///      to set the state variables.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initializes the deployer to owner.
     * @param pancakeSwapRouter_ Address of the PancakeSwap router
     * @param minAmountToConvert_ Minimum amount assets must be worth to convert into base asset
     * @param convertibleBaseAsset_ Address of the base asset
     * @param accessControlManager_ Address of the access control contract
     * @param loopsLimit_ Limit for the loops in the contract to avoid DOS
     * @custom:error ZeroAddressNotAllowed is thrown when PCS router address is zero
     * @custom:error ZeroAddressNotAllowed is thrown when convertible base asset address is zero
     */
    function initialize(
        address pancakeSwapRouter_,
        uint256 minAmountToConvert_,
        address convertibleBaseAsset_,
        address accessControlManager_,
        uint256 loopsLimit_
    ) external initializer {
        ensureNonzeroAddress(pancakeSwapRouter_);
        ensureNonzeroAddress(convertibleBaseAsset_);
        require(minAmountToConvert_ > 0, "Risk Fund: Invalid min amount to convert");
        require(loopsLimit_ > 0, "Risk Fund: Loops limit can not be zero");

        __Ownable2Step_init();
        __AccessControlled_init_unchained(accessControlManager_);

        pancakeSwapRouter = pancakeSwapRouter_;
        minAmountToConvert = minAmountToConvert_;
        convertibleBaseAsset = convertibleBaseAsset_;

        _setMaxLoopsLimit(loopsLimit_);
    }

    /**
     * @dev Pool registry setter
     * @param poolRegistry_ Address of the pool registry
     * @custom:error ZeroAddressNotAllowed is thrown when pool registry address is zero
     */
    function setPoolRegistry(address poolRegistry_) external onlyOwner {
        ensureNonzeroAddress(poolRegistry_);
        address oldPoolRegistry = poolRegistry;
        poolRegistry = poolRegistry_;
        emit PoolRegistryUpdated(oldPoolRegistry, poolRegistry_);
    }

    /**
     * @dev Shortfall contract address setter
     * @param shortfallContractAddress_ Address of the auction contract
     * @custom:error ZeroAddressNotAllowed is thrown when shortfall contract address is zero
     */
    function setShortfallContractAddress(address shortfallContractAddress_) external onlyOwner {
        ensureNonzeroAddress(shortfallContractAddress_);
        require(
            IShortfall(shortfallContractAddress_).convertibleBaseAsset() == convertibleBaseAsset,
            "Risk Fund: Base asset doesn't match"
        );

        address oldShortfallContractAddress = shortfall;
        shortfall = shortfallContractAddress_;
        emit ShortfallContractUpdated(oldShortfallContractAddress, shortfallContractAddress_);
    }

    /**
     * @dev PancakeSwap router address setter
     * @param pancakeSwapRouter_ Address of the PancakeSwap router
     * @custom:error ZeroAddressNotAllowed is thrown when PCS router address is zero
     */
    function setPancakeSwapRouter(address pancakeSwapRouter_) external onlyOwner {
        ensureNonzeroAddress(pancakeSwapRouter_);
        address oldPancakeSwapRouter = pancakeSwapRouter;
        pancakeSwapRouter = pancakeSwapRouter_;
        emit PancakeSwapRouterUpdated(oldPancakeSwapRouter, pancakeSwapRouter_);
    }

    /**
     * @dev Min amount to convert setter
     * @param minAmountToConvert_ Min amount to convert.
     */
    function setMinAmountToConvert(uint256 minAmountToConvert_) external {
        _checkAccessAllowed("setMinAmountToConvert(uint256)");
        require(minAmountToConvert_ > 0, "Risk Fund: Invalid min amount to convert");
        uint256 oldMinAmountToConvert = minAmountToConvert;
        minAmountToConvert = minAmountToConvert_;
        emit MinAmountToConvertUpdated(oldMinAmountToConvert, minAmountToConvert_);
    }

    /**
     * @notice Swap array of pool assets into base asset's tokens of at least a minimum amount.
     * @param markets Array of vTokens whose assets to swap for base asset
     * @param amountsOutMin Minimum amount to receive for swap
     * @return Number of swapped tokens.
     * @custom:error ZeroAddressNotAllowed is thrown if PoolRegistry contract address is not configured
     */
    function swapPoolsAssets(
        address[] calldata markets,
        uint256[] calldata amountsOutMin,
        address[][] calldata paths
    ) external override returns (uint256) {
        _checkAccessAllowed("swapPoolsAssets(address[],uint256[],address[][])");
        ensureNonzeroAddress(poolRegistry);
        require(markets.length == amountsOutMin.length, "Risk fund: markets and amountsOutMin are unequal lengths");
        require(markets.length == paths.length, "Risk fund: markets and paths are unequal lengths");

        uint256 totalAmount;
        uint256 marketsCount = markets.length;

        _ensureMaxLoops(marketsCount);

        for (uint256 i; i < marketsCount; ++i) {
            VToken vToken = VToken(markets[i]);
            address comptroller = address(vToken.comptroller());

            PoolRegistry.VenusPool memory pool = PoolRegistry(poolRegistry).getPoolByComptroller(comptroller);
            require(pool.comptroller == comptroller, "comptroller doesn't exist pool registry");
            require(Comptroller(comptroller).isMarketListed(vToken), "market is not listed");

            uint256 swappedTokens = _swapAsset(vToken, comptroller, amountsOutMin[i], paths[i]);
            poolReserves[comptroller] = poolReserves[comptroller] + swappedTokens;
            totalAmount = totalAmount + swappedTokens;
        }

        emit SwappedPoolsAssets(markets, amountsOutMin, totalAmount);

        return totalAmount;
    }

    /**
     * @dev Transfer tokens for auction.
     * @param comptroller Comptroller of the pool.
     * @param amount Amount to be transferred to auction contract.
     * @return Number reserved tokens.
     */
    function transferReserveForAuction(address comptroller, uint256 amount) external override returns (uint256) {
        require(msg.sender == shortfall, "Risk fund: Only callable by Shortfall contract");
        require(amount <= poolReserves[comptroller], "Risk Fund: Insufficient pool reserve.");
        poolReserves[comptroller] = poolReserves[comptroller] - amount;
        IERC20Upgradeable(convertibleBaseAsset).safeTransfer(shortfall, amount);

        emit TransferredReserveForAuction(comptroller, amount);

        return amount;
    }

    /**
     * @notice Set the limit for the loops can iterate to avoid the DOS
     * @param limit Limit for the max loops can execute at a time
     */
    function setMaxLoopsLimit(uint256 limit) external onlyOwner {
        _setMaxLoopsLimit(limit);
    }

    /**
     * @dev Update the reserve of the asset for the specific pool after transferring to risk fund.
     * @param comptroller  Comptroller address(pool).
     * @param asset Asset address.
     */
    function updateAssetsState(address comptroller, address asset) public override(IRiskFund, ReserveHelpers) {
        super.updateAssetsState(comptroller, asset);
    }

    /**
     * @dev Swap single asset to base asset.
     * @param vToken VToken
     * @param comptroller Comptroller address
     * @param amountOutMin Minimum amount to receive for swap
     * @return Number of swapped tokens.
     */
    function _swapAsset(
        VToken vToken,
        address comptroller,
        uint256 amountOutMin,
        address[] calldata path
    ) internal returns (uint256) {
        require(amountOutMin != 0, "RiskFund: amountOutMin must be greater than 0 to swap vToken");
        require(amountOutMin >= minAmountToConvert, "RiskFund: amountOutMin should be greater than minAmountToConvert");
        uint256 totalAmount;

        address underlyingAsset = vToken.underlying();
        uint256 balanceOfUnderlyingAsset = poolsAssetsReserves[comptroller][underlyingAsset];

        ComptrollerViewInterface(comptroller).oracle().updatePrice(address(vToken));

        uint256 underlyingAssetPrice = ComptrollerViewInterface(comptroller).oracle().getUnderlyingPrice(
            address(vToken)
        );

        if (balanceOfUnderlyingAsset > 0) {
            Exp memory oraclePrice = Exp({ mantissa: underlyingAssetPrice });
            uint256 amountInUsd = mul_ScalarTruncate(oraclePrice, balanceOfUnderlyingAsset);

            if (amountInUsd >= minAmountToConvert) {
                assetsReserves[underlyingAsset] -= balanceOfUnderlyingAsset;
                poolsAssetsReserves[comptroller][underlyingAsset] -= balanceOfUnderlyingAsset;

                if (underlyingAsset != convertibleBaseAsset) {
                    require(path[0] == underlyingAsset, "RiskFund: swap path must start with the underlying asset");
                    require(
                        path[path.length - 1] == convertibleBaseAsset,
                        "RiskFund: finally path must be convertible base asset"
                    );
                    IERC20Upgradeable(underlyingAsset).approve(pancakeSwapRouter, 0);
                    IERC20Upgradeable(underlyingAsset).approve(pancakeSwapRouter, balanceOfUnderlyingAsset);
                    uint256[] memory amounts = IPancakeswapV2Router(pancakeSwapRouter).swapExactTokensForTokens(
                        balanceOfUnderlyingAsset,
                        amountOutMin,
                        path,
                        address(this),
                        block.timestamp
                    );
                    totalAmount = amounts[path.length - 1];
                } else {
                    totalAmount = balanceOfUnderlyingAsset;
                }
            }
        }

        return totalAmount;
    }
}
