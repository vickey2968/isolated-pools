import { ethers } from "hardhat";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

interface Config {
  [key: string]: string;
}

const targetOwners: Config = {
  hardhat: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // signer[1] from hardhat mnemonic
  bsctestnet: "0xFA747c4a62c4D168276329F822d004026A1c05E9", // signer[1] from testnet mnemonic
  mainnet: "0x939bD8d64c0A9583A7Dcea9933f7b21697ab6396", // NORMAL VIP Timelock
};

const contracts = ["RiskFund", "Shortfall", "ProtocolShareReserve"];

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await transfer2StepOwnerships(contracts, hre.network.name);
};

const transfer2StepOwnerships = async (contractNames: string[], networkName: string) => {
  for (const contractName of contractNames) {
    const contract = await ethers.getContract(contractName);
    const owner = await contract.owner();

    let tx;
    if (owner !== targetOwners[networkName]) {
      tx = await contract.transferOwnership(targetOwners[networkName]);
      await tx.wait(1);
      const pendingOwner = await contract.pendingOwner();
      console.log(
        `${contractName} owner ${owner} sucessfully changed to ${pendingOwner}. Please accept the ownership.`,
      );
    } else {
      console.error(`${contractName} owner ${owner} is equal to target ownership address ${targetOwners[networkName]}`);
    }
  }
};

func.tags = ["TransferFundsOwnership"];
export default func;
