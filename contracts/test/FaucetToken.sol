// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.10;

import { StandardToken, NonStandardToken } from "./ERC20.sol";
import { SafeMath } from "./SafeMath.sol";

/**
 * @title The Compound Faucet Test Token
 * @author Compound
 * @notice A simple test token that lets anyone get more of it.
 */
contract FaucetToken is StandardToken {
    constructor(
        uint256 _initialAmount,
        string memory _tokenName,
        uint8 _decimalUnits,
        string memory _tokenSymbol
    )
        StandardToken(_initialAmount, _tokenName, _decimalUnits, _tokenSymbol)
    /* solhint-disable-next-line no-empty-blocks */
    {

    }

    function allocateTo(address _owner, uint256 value) public {
        balanceOf[_owner] += value;
        totalSupply += value;
        emit Transfer(address(this), _owner, value);
    }
}

/**
 * @title The Compound Faucet Test Token (non-standard)
 * @author Compound
 * @notice A simple test token that lets anyone get more of it.
 */
contract FaucetNonStandardToken is NonStandardToken {
    constructor(
        uint256 _initialAmount,
        string memory _tokenName,
        uint8 _decimalUnits,
        string memory _tokenSymbol
    )
        NonStandardToken(_initialAmount, _tokenName, _decimalUnits, _tokenSymbol)
    /* solhint-disable-next-line no-empty-blocks */
    {

    }

    function allocateTo(address _owner, uint256 value) public {
        balanceOf[_owner] += value;
        totalSupply += value;
        emit Transfer(address(this), _owner, value);
    }
}

/**
 * @title The Compound Faucet Re-Entrant Test Token
 * @author Compound
 * @notice A test token that is malicious and tries to re-enter callers
 */
contract FaucetTokenReEntrantHarness {
    using SafeMath for uint256;

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 private totalSupply_;
    mapping(address => mapping(address => uint256)) private allowance_;
    mapping(address => uint256) private balanceOf_;

    bytes public reEntryCallData;
    string public reEntryFun;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    modifier reEnter(string memory funName) {
        string memory _reEntryFun = reEntryFun;
        if (compareStrings(_reEntryFun, funName)) {
            reEntryFun = ""; // Clear re-entry fun
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, bytes memory returndata) = msg.sender.call(reEntryCallData);
            // solhint-disable-next-line no-inline-assembly
            assembly {
                if eq(success, 0) {
                    revert(add(returndata, 0x20), returndatasize())
                }
            }
        }

        _;
    }

    constructor(
        uint256 _initialAmount,
        string memory _tokenName,
        uint8 _decimalUnits,
        string memory _tokenSymbol,
        bytes memory _reEntryCallData,
        string memory _reEntryFun
    ) {
        totalSupply_ = _initialAmount;
        balanceOf_[msg.sender] = _initialAmount;
        name = _tokenName;
        symbol = _tokenSymbol;
        decimals = _decimalUnits;
        reEntryCallData = _reEntryCallData;
        reEntryFun = _reEntryFun;
    }

    function allocateTo(address _owner, uint256 value) public {
        balanceOf_[_owner] += value;
        totalSupply_ += value;
        emit Transfer(address(this), _owner, value);
    }

    function totalSupply() public reEnter("totalSupply") returns (uint256) {
        return totalSupply_;
    }

    function allowance(address owner, address spender) public reEnter("allowance") returns (uint256 remaining) {
        return allowance_[owner][spender];
    }

    function approve(address spender, uint256 amount) public reEnter("approve") returns (bool success) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address owner) public reEnter("balanceOf") returns (uint256 balance) {
        return balanceOf_[owner];
    }

    function transfer(address dst, uint256 amount) public reEnter("transfer") returns (bool success) {
        _transfer(msg.sender, dst, amount);
        return true;
    }

    function transferFrom(
        address src,
        address dst,
        uint256 amount
    ) public reEnter("transferFrom") returns (bool success) {
        _transfer(src, dst, amount);
        _approve(src, msg.sender, allowance_[src][msg.sender].sub(amount));
        return true;
    }

    function _approve(
        address owner,
        address spender,
        uint256 amount
    ) internal {
        require(spender != address(0), "FaucetToken: approve to the zero address");
        require(owner != address(0), "FaucetToken: approve from the zero address");
        allowance_[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _transfer(
        address src,
        address dst,
        uint256 amount
    ) internal {
        require(dst != address(0), "FaucetToken: transfer to the zero address");
        balanceOf_[src] = balanceOf_[src].sub(amount);
        balanceOf_[dst] = balanceOf_[dst].add(amount);
        emit Transfer(src, dst, amount);
    }

    function compareStrings(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(abi.encodePacked((a))) == keccak256(abi.encodePacked((b)));
    }
}
