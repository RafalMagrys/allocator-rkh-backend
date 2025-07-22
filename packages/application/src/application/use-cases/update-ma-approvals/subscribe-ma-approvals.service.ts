// FIXME create a proper injectable service for this file
import { Command, ICommandBus, Logger } from '@filecoin-plus/core';
import { Container } from 'inversify';
import { TYPES } from '@src/types';
import { UpdateMetaAllocatorApprovalsCommand } from '@src/application/use-cases/update-ma-approvals/update-ma-approvals.command';
import { IApplicationDetailsRepository } from '@src/infrastructure/respositories/application-details.repository';
import config from '@src/config';
import { ethers } from 'ethers';
import { MongoClient } from 'mongodb';
import { IIssueDetailsRepository } from '@src/infrastructure/respositories/issue-details.repository';
import { ApproveRefreshByMaCommand } from '@src/application/use-cases/update-ma-approvals/approve-refresh-by-ma.command';
import { executeWithFallback } from '@src/patterns/execution/executeWithFallback';

const ALLOWANCE_CHANGED_EVENT_ABI = [
  {
    type: 'event',
    name: 'AllowanceChanged',
    inputs: [
      {
        name: 'allocator',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'allowanceBefore',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'allowanceAfter',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
];

type Approval = {
  blockNumber: number;
  txHash: string;
  contractAddress: string;
  allocatorAddress: string;
  allowanceBefore: string;
  allowanceAfter: string;
};

export function ensureSubscribeMetaAllocatorApprovalsConfig() {
  const expectedConfigVars = [
    'SUBSCRIBE_META_ALLOCATOR_APPROVALS_POLLING_INTERVAL',
    'VALID_META_ALLOCATOR_ADDRESSES',
    'LOTUS_RPC_URL',
    'MONGODB_URI',
  ];
  for (let configVar of expectedConfigVars) {
    if (!config[configVar]) {
      throw new Error(`Missing config variable: '${configVar}'`);
    }
  }
}

async function fetchApprovals(fromBlock: number): Promise<any[]> {
  console.log(`Fetching approvals from block ${fromBlock}...`);
  const provider = new ethers.providers.JsonRpcProvider(config.EVM_RPC_URL, {
    name: 'filecoin-local',
    chainId: 31415926,
  });

  /* Ensure 'fromBlock' is within the allowed lookback range.
     Lotus enforces exactly that “no more than 16h40m” window, which is 2000 epochs.
     Any lookback more than that will be rejected so we have to accept some
     lossiness here if (eg the service goes down for a bit).
     Using 1990 to allow a little headroom for race conditions */
  const head = await provider.getBlockNumber();
  console.log(`Head block is ${head}.`);
  const from = fromBlock > head - 2000 ? fromBlock : head - 1990;
  console.log(`After adjustment fetching approvals from block ${from}...`);

  const iface = new ethers.utils.Interface(ALLOWANCE_CHANGED_EVENT_ABI);
  const eventTopic = iface.getEventTopic('AllowanceChanged');

  const filter = {
    fromBlock: from,
    toBlock: head,
    topics: [eventTopic],
  };
  let logs: any[];
  try {
    logs = await provider.getLogs(filter);
    console.log(`Ethers returned ${logs.length} logs...`);
  } catch (error) {
    console.log(`Ethers fetch FAILED...`);
    console.error(error);
    return [];
  }

  const approvals: Approval[] = [];
  for (let log of logs) {
    try {
      console.log(`Processing log ${log.transactionHash}...`);
      console.log(log);
      const decoded = iface.decodeEventLog('AllowanceChanged', log.data, log.topics);
      if (decoded) {
        console.log(`Decoded log ${log.transactionHash} SUCCESS...`);
        console.log(decoded);
        const approval = {
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          contractAddress: log.address,
          allocatorAddress: decoded.allocator,
          allowanceBefore: decoded.allowanceBefore.toString(),
          allowanceAfter: decoded.allowanceAfter.toString(),
        };
        approvals.push(approval);
      } else {
        console.log(`Decoded log ${log.transactionHash} FAILED...`);
      }
    } catch (error) {
      console.log(`Decoding log ${log.transactionHash} ERROR...`);
    }
  }

  console.log(`Found ${approvals.length} AllowanceChanged events...`);
  console.log(approvals);
  return approvals;
}

async function fetchLastBlockMetaAllocator(
  databaseName: string,
  collectionName: string,
): Promise<number> {
  const client = new MongoClient(config.MONGODB_URI);
  try {
    await client.connect();
    const database = client.db(databaseName);
    const collection = database.collection(collectionName);
    const document = await collection
      .find({ metaAllocator: { $exists: true } })
      .sort({ 'metaAllocator.blockNumber': -1 })
      .limit(1)
      .toArray();

    if (document.length > 0) {
      return document[0].metaAllocator.blockNumber;
    } else {
      return -1;
    }
  } catch (error) {
    return -1;
  } finally {
    await client.close();
  }
}

//FIXME move it to services
export async function subscribeMetaAllocatorApprovals(container: Container) {
  const logger = container.get<Logger>(TYPES.Logger);
  const commandBus = container.get<ICommandBus>(TYPES.CommandBus);
  const applicationDetailsRepository = container.get<IApplicationDetailsRepository>(
    TYPES.ApplicationDetailsRepository,
  );
  const issuesRepository = container.get<IIssueDetailsRepository>(
    TYPES.ApplicationDetailsRepository,
  );

  let shouldContinue = true;

  const intervalId = setInterval(async () => {
    try {
      ensureSubscribeMetaAllocatorApprovalsConfig();
    } catch (error) {
      logger.error('Failed to subscribe to MetaAllocator proposals.', error);
      clearInterval(intervalId);
      return;
    }

    if (!shouldContinue) {
      logger.info('Unsubscribing from MetaAllocator proposals...');
      clearInterval(intervalId);
      return;
    }

    logger.info('Subscribing to MetaAllocator proposals...');

    try {
      logger.info('Fetching lastBlock...');
      const applicationLastBlock = await fetchLastBlockMetaAllocator(
        'filecoin-plus',
        'applicationDetails',
      );
      const issueLastBlock = await fetchLastBlockMetaAllocator('filecoin-plus', 'issueDetails');
      const lastBlock = Math.max(applicationLastBlock, issueLastBlock);
      logger.info(`Last block is ${lastBlock}.`);
      logger.info('Fetching approvals...');
      const approvals = await fetchApprovals(lastBlock + 1);
      logger.info(
        `Found ${approvals.length} AllowanceChanged events since block ${lastBlock + 1}.`,
      );

      for (let approval of approvals) {
        logger.info(
          `Processing approval ${approval.txHash}, approved by ${approval.contractAddress}...`,
        );
        if (config.VALID_META_ALLOCATOR_ADDRESSES.includes(approval.contractAddress)) {
          let actorId = approval.allocatorAddress;
          if (actorId.startsWith('0x')) {
            console.log(`Allocator Id is an Ethereum address: ${actorId}`);
            // If the address is an Ethereum address, convert to Filecoin Id first
            const provider = new ethers.providers.JsonRpcProvider(config.EVM_RPC_URL, {
              name: 'filecoin-local',
              chainId: 31415926,
            });
            const filecoinId = await provider.send('Filecoin.EthAddressToFilecoinAddress', [
              actorId,
            ]);
            console.log(`Converted to Filecoin id: ${filecoinId}`);
            if (!filecoinId) {
              logger.error('Failed to convert Ethereum address to Filecoin address:', actorId);
            }
            actorId = filecoinId;
          }
          try {
            await executeWithFallback<Command>({
              primary: () =>
                handleMetaAllocatorIssueApproval({
                  approval,
                  actorId,
                  issuesRepository,
                }),
              fallback: () =>
                handleMetaAllocatorApplicationApproval({
                  approval,
                  actorId,
                  applicationDetailsRepository,
                }),
              onPrimaryError: error =>
                logger.error(
                  'Error updating Issue MetaAllocator approval, trying Application:',
                  error,
                ),
              onFallbackError: error =>
                logger.error('Both Issue and Application handlers failed:', error),
              onSuccess: command => commandBus.send(command),
            });

            logger.info(`Successfully processed MetaAllocator approval for actorId: ${actorId}`);
          } catch (error) {
            logger.error('Error updating Meta Allocator approvals', error);
          }
        } else {
          logger.debug(`Invalid contract address: ${approval.contractAddress}`);
          logger.debug(config.VALID_META_ALLOCATOR_ADDRESSES);
        }
      }
    } catch (err) {
      logger.error('subscribeMetaAllocatorApprovals uncaught exception', err);
      // swallow error and wait for next tick
    }
  }, config.SUBSCRIBE_META_ALLOCATOR_APPROVALS_POLLING_INTERVAL);

  return () => {
    shouldContinue = false;
  };
}

export async function handleMetaAllocatorIssueApproval({
  approval,
  actorId,
  issuesRepository,
}: {
  approval: Approval;
  actorId: string;
  issuesRepository: IIssueDetailsRepository;
}) {
  const issue = await issuesRepository.findPendingBy({ actorId: actorId });
  if (!issue) throw new Error(`Issue not found for actorId ${actorId}`);

  return new ApproveRefreshByMaCommand(issue, approval);
}

export async function handleMetaAllocatorApplicationApproval({
  approval,
  actorId,
  applicationDetailsRepository,
}: {
  approval: Approval;
  actorId: string;
  applicationDetailsRepository: IApplicationDetailsRepository;
}) {
  const applicationDetails = await applicationDetailsRepository.getByActorId(actorId);
  if (!applicationDetails) throw new Error(`Application details not found for actorId ${actorId}`);

  return new UpdateMetaAllocatorApprovalsCommand(
    applicationDetails.id,
    approval.blockNumber,
    approval.txHash,
  );
}
