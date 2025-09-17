import { Command, Logger } from '@filecoin-plus/core';
import { inject, injectable } from 'inversify';
import { WithId } from 'mongodb';
import {
  FINISHED_REFRESH_STATUSES,
  IssueDetails,
  PENDING_REFRESH_STATUSES,
  RefreshStatus,
} from '@src/infrastructure/repositories/issue-details';
import { SaveIssueCommand } from './save-issue.command';
import { SaveIssueWithNewAuditCommand } from './save-issue-with-new-audit.command';
import { TYPES } from '@src/types';
import { IIssueDetailsRepository } from '@src/infrastructure/repositories/issue-details.repository';
import { LOG_MESSAGES, RESPONSE_MESSAGES } from '@src/constants';

const LOG = LOG_MESSAGES.UPSERT_ISSUE_STRATEGY_RESOLVER;
const RES = RESPONSE_MESSAGES.UPSERT_ISSUE_STRATEGY_RESOLVER;

export enum UpsertStrategyKey {
  SAVE_WITH_NEW_AUDIT = 'save-with-new-audit',
  SAVE_WITHOUT_GITHUB_UPDATE = 'update-existing-without-github-update',
}

interface AuditStateAnalysis {
  issueByGithubIdExists: boolean;
  isIssueByGithubIdFinished: boolean;
  isLatestAuditByJsonNumberPending: boolean;
  areTheSameIssue: boolean;
}

export interface IUpsertStrategy {
  execute(issueDetails: IssueDetails): Promise<Command>;
}

@injectable()
export class SaveWithoutGithubUpdateStrategy implements IUpsertStrategy {
  async execute(issueDetails: IssueDetails): Promise<Command> {
    return new SaveIssueCommand(issueDetails);
  }
}

@injectable()
export class SaveWithNewAuditStrategy implements IUpsertStrategy {
  async execute(issueDetails: IssueDetails): Promise<Command> {
    return new SaveIssueWithNewAuditCommand(issueDetails);
  }
}

@injectable()
export class UpsertIssueStrategyResolver {
  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.IssueDetailsRepository)
    private readonly repository: IIssueDetailsRepository,
  ) {}

  public async resolveAndExecute(mappedIsuueFromGithub: IssueDetails): Promise<Command> {
    this.logger.info(LOG.RESOLVING_UPSERT_ISSUE_STRATEGY);
    const strategyKey = await this.getStrategyKey(mappedIsuueFromGithub);

    this.logger.info(LOG.STRATEGY_SELECTED + strategyKey);

    const strategy = this.getStrategyByKey(strategyKey);
    return strategy.execute(mappedIsuueFromGithub);
  }

  private getStrategyByKey(strategyKey: UpsertStrategyKey): IUpsertStrategy {
    switch (strategyKey) {
      case UpsertStrategyKey.SAVE_WITHOUT_GITHUB_UPDATE:
        return new SaveWithoutGithubUpdateStrategy();
      case UpsertStrategyKey.SAVE_WITH_NEW_AUDIT:
        return new SaveWithNewAuditStrategy();
      default:
        throw new Error(`Unknown strategy key: ${strategyKey}`);
    }
  }

  private async getStrategyKey(mappedIsuueFromGithub: IssueDetails): Promise<UpsertStrategyKey> {
    const [issueByGithubId, issueWithLatestAuditByJsonNumber] =
      await this.getRelatedIssues(mappedIsuueFromGithub);

    const {
      issueByGithubIdExists,
      isIssueByGithubIdFinished,
      isLatestAuditByJsonNumberPending,
      areTheSameIssue,
    } = this.analyzeAuditState(issueByGithubId, issueWithLatestAuditByJsonNumber);

    if (isIssueByGithubIdFinished)
      throw new Error(
        `${mappedIsuueFromGithub.githubIssueNumber} ${RES.ISSUE_REFRESH_ALREADY_FINISHED}`,
      );

    if (areTheSameIssue) return UpsertStrategyKey.SAVE_WITHOUT_GITHUB_UPDATE;

    if (isLatestAuditByJsonNumberPending)
      throw new Error(`${mappedIsuueFromGithub.jsonNumber} ${RES.PENDING_AUDIT}`);

    if (issueByGithubIdExists && !isLatestAuditByJsonNumberPending)
      return UpsertStrategyKey.SAVE_WITHOUT_GITHUB_UPDATE;

    if (!issueByGithubIdExists && !isLatestAuditByJsonNumberPending)
      return UpsertStrategyKey.SAVE_WITH_NEW_AUDIT;

    if (!areTheSameIssue && isLatestAuditByJsonNumberPending)
      throw new Error(`${RES.CANNOT_RESOLVE_UPSERT_STRATEGY} ${mappedIsuueFromGithub.jsonNumber}`);

    throw new Error(`${RES.CANNOT_RESOLVE_UPSERT_STRATEGY} ${mappedIsuueFromGithub.jsonNumber}`);
  }

  private analyzeAuditState(
    issueByGithubId: WithId<IssueDetails> | null,
    issueWithLatestAuditByJsonNumber: WithId<IssueDetails> | null,
  ): AuditStateAnalysis {
    const issueByGithubIdExists = !!issueByGithubId;

    const isIssueByGithubIdFinished =
      !!issueByGithubId &&
      FINISHED_REFRESH_STATUSES.includes(issueByGithubId.refreshStatus as RefreshStatus);

    const isLatestAuditByJsonNumberPending = PENDING_REFRESH_STATUSES.includes(
      issueWithLatestAuditByJsonNumber?.refreshStatus as RefreshStatus,
    );

    const areTheSameIssue =
      !!issueByGithubId &&
      !!issueWithLatestAuditByJsonNumber &&
      issueByGithubId.githubIssueId === issueWithLatestAuditByJsonNumber.githubIssueId;

    return {
      issueByGithubIdExists,
      isIssueByGithubIdFinished,
      isLatestAuditByJsonNumberPending,
      areTheSameIssue,
    };
  }

  private async getRelatedIssues(
    issueDetails: IssueDetails,
  ): Promise<[WithId<IssueDetails> | null, WithId<IssueDetails> | null]> {
    return await Promise.all([
      this.repository.findBy('githubIssueId', issueDetails.githubIssueId),
      this.repository.findWithLatestAuditBy('jsonNumber', issueDetails.jsonNumber),
    ]);
  }
}
