import { IRepository } from '@filecoin-plus/core';
import { inject, injectable } from 'inversify';
import { Db } from 'mongodb';

import { ApplicationDetails } from './application-details.types';
import { TYPES } from '@src/types';
import { ApplicationStatus } from '@src/domain/application/application';

type PaginatedResults<T> = {
  results: T[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    itemsPerPage: number;
  };
};

export interface IApplicationDetailsRepository extends IRepository<ApplicationDetails> {
  update(applicationDetails: Partial<ApplicationDetails>): Promise<void>;

  getPaginated(
    page: number,
    limit: number,
    status: ApplicationStatus[],
    search?: string,
  ): Promise<PaginatedResults<ApplicationDetails>>;

  getAll(): Promise<ApplicationDetails[]>;

  getByActorId(actorId: string): Promise<ApplicationDetails | null>;

  getByAddress(address: string): Promise<ApplicationDetails | null>;

  getByProposalId(proposalId: number): Promise<ApplicationDetails | null>;

  getPendingBy<K extends keyof ApplicationDetails>(
    key: K,
    value: ApplicationDetails[K],
  ): Promise<ApplicationDetails | null>;
}

@injectable()
class ApplicationDetailsRepository implements IRepository<ApplicationDetails> {
  constructor(@inject(TYPES.Db) private readonly _db: Db) {}

  async save(applicationDetails: ApplicationDetails, expectedVersion: number = 0): Promise<void> {
    await this._db
      .collection<ApplicationDetails>('applicationDetails')
      .updateOne(
        { applicationId: applicationDetails.id },
        { $set: applicationDetails },
        { upsert: true },
      );
  }

  async getById(guid: string): Promise<ApplicationDetails> {
    return this._db
      .collection<ApplicationDetails>('applicationDetails')
      .findOne({ applicationId: guid }) as Promise<ApplicationDetails>;
  }

  async update(applicationDetails: Partial<ApplicationDetails>): Promise<void> {
    await this._db
      .collection<ApplicationDetails>('applicationDetails')
      .updateOne(
        { applicationId: applicationDetails.id },
        { $set: applicationDetails },
        { upsert: true },
      );
  }

  async getPaginated(
    page: number,
    limit: number,
    status: ApplicationStatus[],
    search?: string,
  ): Promise<PaginatedResults<ApplicationDetails>> {
    const skip = (page - 1) * limit;
    const filter: any = {};
    const orConditions: any[] = [];

    if (status.length > 0) {
      orConditions.push({
        status: {
          $in: status,
        },
      });
    }

    if (orConditions.length > 0) {
      filter.$or = orConditions;
    }

    if (search) {
      filter.$and = [
        {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { address: { $regex: search, $options: 'i' } },
          ],
        },
      ];
    }

    const totalCount = await this._db
      .collection<ApplicationDetails>('applicationDetails')
      .countDocuments(filter);
    const applications = await this._db
      .collection<ApplicationDetails>('applicationDetails')
      .find(filter)
      .skip(skip)
      .limit(limit)
      .toArray();

    return {
      results: applications,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        itemsPerPage: limit,
      },
    };
  }

  async getAll(): Promise<ApplicationDetails[]> {
    return this._db.collection<ApplicationDetails>('applicationDetails').find({}).toArray();
  }

  async getByActorId(actorId: string): Promise<ApplicationDetails | null> {
    return this._db.collection<ApplicationDetails>('applicationDetails').findOne({ actorId });
  }

  async getPendingBy<K extends keyof ApplicationDetails>(
    key: K,
    value: ApplicationDetails[K],
  ): Promise<ApplicationDetails | null> {
    return this._db.collection<ApplicationDetails>('applicationDetails').findOne({
      [key]: value,
      status: { $nin: [ApplicationStatus.DC_ALLOCATED, ApplicationStatus.REJECTED] },
    });
  }

  async getByAddress(address: string): Promise<ApplicationDetails | null> {
    console.log('getByAddress', address);
    return this._db.collection<ApplicationDetails>('applicationDetails').findOne({ address });
  }

  async getByProposalId(proposalId: number): Promise<ApplicationDetails | null> {
    console.log('getByProposalId', proposalId);
    return this._db.collection<ApplicationDetails>('applicationDetails').findOne({
      'rkhPhase.approvalMessageId': proposalId,
    });
  }
}

export { ApplicationDetailsRepository };
