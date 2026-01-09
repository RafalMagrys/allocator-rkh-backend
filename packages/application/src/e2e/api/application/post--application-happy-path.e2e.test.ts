import 'reflect-metadata';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { Container } from 'inversify';
import { Db, InsertOneResult } from 'mongodb';
import { Application, json, urlencoded } from 'express';
import { InversifyExpressServer } from 'inversify-express-utils';
import '@src/api/http/controllers/application.controller';
import { FilecoinTxBuilder } from '@src/testing/mocks/builders';

import { TYPES } from '@src/types';
import { ApplicationStatus } from '@src/domain/application/application';
import { ApplicationDetails } from '@src/infrastructure/repositories/application-details.types';
import { IApplicationDetailsRepository } from '@src/infrastructure/repositories/application-details.repository';
import { IGithubClient } from '@src/infrastructure/clients/github';
import { TestContainerBuilder } from '@mocks/builders';

/**
 * E2E Tests for Application Happy Path
 *
 * Prerequisites:
 * - MongoDB must be running (default: mongodb://localhost:27017)
 * - Set MONGODB_URI environment variable to override default
 *
 * These tests cover the complete application lifecycle:
 * 1. Application Creation -> KYC_PHASE
 * 2. KYC Approval -> GOVERNANCE_REVIEW_PHASE
 * 3. Governance Review Approval -> RKH_APPROVAL_PHASE or META_APPROVAL_PHASE
 * 4. Final Approval -> DC_ALLOCATED
 */

const githubMock = vi.hoisted(() => ({
  createBranch: vi.fn(),
  createPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  deleteBranch: vi.fn(),
  getFile: vi.fn(),
  updateFile: vi.fn(),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-nanoid'),
}));

describe('Application Happy Path E2E Tests', () => {
  let app: Application;
  let container: Container;
  let db: Db;
  let applicationRepository: IApplicationDetailsRepository;
  let governanceTeamAddress: string;
  let kycTransaction: any;
  let governanceApprovalTransaction: any;

  const TEST_APPLICATION_ID = 'test-app-happy-path-001';
  const APPLICANT_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

  beforeAll(async () => {
    // Build transactions for KYC and Governance Review with correct signatures
    const [kycTx, govTx] = await Promise.all([
      new FilecoinTxBuilder()
        .withChallenge(`KYC Override for ${TEST_APPLICATION_ID}`)
        .build(),
      new FilecoinTxBuilder()
        .withChallenge(`Governance approve ${TEST_APPLICATION_ID} 1000 RKH`)
        .build(),
    ]);

    kycTransaction = kycTx;
    governanceApprovalTransaction = govTx;
    governanceTeamAddress = kycTx.address;

    // Setup test container
    const testBuilder = new TestContainerBuilder();
    await testBuilder.withDatabase();
    const testSetup = testBuilder
      .withLogger()
      .withConfig(TYPES.GovernanceConfig, {
        addresses: [governanceTeamAddress],
      })
      .withConfig(TYPES.AllocatorGovernanceConfig, { owner: 'test-owner', repo: 'test-repo' })
      .withConfig(TYPES.AllocatorRegistryConfig, { owner: 'test-owner', repo: 'test-registry' })
      .withEventBus()
      .withCommandBus()
      .withQueryBus()
      .withMappers()
      .withResolvers()
      .withPublishers()
      .withServices()
      .withGithubClient(githubMock as unknown as IGithubClient)
      .withRepositories()
      .withCommandHandlers()
      .withQueryHandlers()
      .registerHandlers()
      .build();

    container = testSetup.container;
    db = testSetup.db;
    applicationRepository = container.get<IApplicationDetailsRepository>(
      TYPES.ApplicationDetailsRepository,
    );

    // Build Express app
    const server = new InversifyExpressServer(container);
    server.setConfig((app: Application) => {
      app.use(urlencoded({ extended: true }));
      app.use(json());
    });

    app = server.build();
    app.listen();

    console.log(`Test setup complete. Database: ${db.databaseName}`);
  });

  beforeEach(async () => {
    // Mock GitHub responses
    githubMock.getFile.mockResolvedValue({
      content: JSON.stringify({
        id: TEST_APPLICATION_ID,
        address: APPLICANT_ADDRESS,
        name: 'Test Allocator',
        organization: 'Test Org',
        audits: [
          {
            outcome: 'PENDING',
            started: new Date().toISOString(),
          },
        ],
        pathway_addresses: {
          msig: 'f2test',
        },
      }),
    });
    githubMock.createBranch.mockResolvedValue({ ref: 'refs/heads/test-branch' });
    githubMock.createPullRequest.mockResolvedValue({
      number: 100,
      head: { sha: 'test-sha' },
      html_url: 'https://github.com/test/test/pull/100',
    });
    githubMock.updateFile.mockResolvedValue({});
    githubMock.mergePullRequest.mockResolvedValue({});
    githubMock.deleteBranch.mockResolvedValue({});
  });

  afterEach(async () => {
    await db.collection('issueDetails').deleteMany({});
    await db.collection('refreshDetails').deleteMany({});
    await db.collection('applicationDetails').deleteMany({});
  });

  describe('RKH Pathway - Complete Happy Path', () => {
    it('should successfully process application through all phases (KYC -> Gov Review -> RKH Approval)', async () => {
      vi.useFakeTimers();
      const now = new Date('2024-01-01T00:00:00.000Z');
      vi.setSystemTime(now);

      // Step 1: Create application in database (simulating application creation)
      const applicationDetails: Partial<ApplicationDetails> = {
        id: TEST_APPLICATION_ID,
        number: 1001,
        name: 'Test Allocator',
        organization: 'Test Organization',
        address: APPLICANT_ADDRESS,
        github: 'test-github',
        allocationTrancheSchedule: 'test-schedule',
        datacap: 0,
        status: ApplicationStatus.KYC_PHASE,
        applicationDetails: {
          pullRequestUrl: 'https://github.com/test/test/pull/1',
          pullRequestNumber: 1,
        },
        applicationInstructions: [
          {
            method: '',
            datacap_amount: 5,
            startTimestamp: now.getTime(),
            status: 'PENDING',
          },
        ],
      };

      await db.collection('applicationDetails').insertOne(applicationDetails as any);

      // Verify initial status
      let application = await applicationRepository.getById(TEST_APPLICATION_ID);
      expect(application?.status).toBe(ApplicationStatus.KYC_PHASE);

      // Step 2: Approve KYC
      const kycApprovalResponse = await request(app)
        .post(`/api/v1/applications/${TEST_APPLICATION_ID}/approveKYC`)
        .send({
          reviewerAddress: kycTransaction.address,
          reviewerPublicKey: kycTransaction.pubKeyBase64,
          signature: kycTransaction.transaction,
          reason: 'KYC verification successful',
        })
        .expect(200);

      expect(kycApprovalResponse.body).toStrictEqual({
        status: '200',
        message: 'KYC result submitted successfully',
        data: {},
      });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify status moved to GOVERNANCE_REVIEW_PHASE
      application = await applicationRepository.getById(TEST_APPLICATION_ID);
      expect(application?.status).toBe(ApplicationStatus.GOVERNANCE_REVIEW_PHASE);

      // Step 3: Approve Governance Review (RKH pathway - MDMA allocator)
      const govApprovalResponse = await request(app)
        .post(`/api/v1/applications/${TEST_APPLICATION_ID}/approveGovernanceReview`)
        .send({
          result: 'approve',
          details: {
            reviewerAddress: governanceApprovalTransaction.address,
            reviewerPublicKey: governanceApprovalTransaction.pubKeyBase64,
            finalDataCap: 1000,
            allocatorType: 'RKH',
          },
          signature: governanceApprovalTransaction.transaction,
        })
        .expect(200);

      expect(govApprovalResponse.body).toStrictEqual({
        status: '200',
        message: 'Governance Team Review result submitted successfully',
        data: {},
      });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify final status - should be DC_ALLOCATED for MDMA allocator on RKH pathway
      application = await applicationRepository.getById(TEST_APPLICATION_ID);
      expect(application?.status).toBe(ApplicationStatus.DC_ALLOCATED);

      // Verify application instructions were updated
      const instructions = application?.applicationInstructions;
      expect(instructions).toBeDefined();
      expect(instructions!.length).toBeGreaterThan(0);
      const lastInstruction = instructions![instructions!.length - 1];
      expect(lastInstruction.datacap_amount).toBe(1000);
      expect(lastInstruction.method).toBe('RKH');
      expect(lastInstruction.status).toBe('GRANTED');

      vi.useRealTimers();
    });
  });

  describe('Meta-Allocator Pathway - Complete Happy Path', () => {
    it('should successfully process application through all phases with Meta-Allocator approval', async () => {
      vi.useFakeTimers();
      const now = new Date('2024-01-01T00:00:00.000Z');
      vi.setSystemTime(now);

      const metaAppId = 'test-app-meta-001';

      // Build governance approval transaction for meta-allocator
      const metaGovTx = await new FilecoinTxBuilder()
        .withChallenge(`Governance approve ${metaAppId} 2000 MDMA`)
        .build();

      // Step 1: Create application in database
      const applicationDetails: Partial<ApplicationDetails> = {
        id: metaAppId,
        number: 1002,
        name: 'Test Meta Allocator',
        organization: 'Test Meta Organization',
        address: APPLICANT_ADDRESS,
        github: 'test-github-meta',
        allocationTrancheSchedule: 'test-schedule',
        datacap: 0,
        status: ApplicationStatus.KYC_PHASE,
        applicationDetails: {
          pullRequestUrl: 'https://github.com/test/test/pull/2',
          pullRequestNumber: 2,
        },
        applicationInstructions: [
          {
            method: '',
            datacap_amount: 5,
            startTimestamp: now.getTime(),
            status: 'PENDING',
          },
        ],
      };

      await db.collection('applicationDetails').insertOne(applicationDetails as any);

      // Step 2: Approve KYC
      const kycTxMeta = await new FilecoinTxBuilder()
        .withChallenge(`KYC Override for ${metaAppId}`)
        .build();

      await request(app)
        .post(`/api/v1/applications/${metaAppId}/approveKYC`)
        .send({
          reviewerAddress: kycTxMeta.address,
          reviewerPublicKey: kycTxMeta.pubKeyBase64,
          signature: kycTxMeta.transaction,
          reason: 'KYC verification successful',
        })
        .expect(200);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify status moved to GOVERNANCE_REVIEW_PHASE
      let application = await applicationRepository.getById(metaAppId);
      expect(application?.status).toBe(ApplicationStatus.GOVERNANCE_REVIEW_PHASE);

      // Step 3: Approve Governance Review (Meta-Allocator pathway - MDMA allocator)
      await request(app)
        .post(`/api/v1/applications/${metaAppId}/approveGovernanceReview`)
        .send({
          result: 'approve',
          details: {
            reviewerAddress: metaGovTx.address,
            reviewerPublicKey: metaGovTx.pubKeyBase64,
            finalDataCap: 2000,
            allocatorType: 'MDMA',
          },
          signature: metaGovTx.transaction,
        })
        .expect(200);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify final status - should be DC_ALLOCATED for MDMA allocator
      application = await applicationRepository.getById(metaAppId);
      expect(application?.status).toBe(ApplicationStatus.DC_ALLOCATED);

      // Verify application instructions
      const instructions = application?.applicationInstructions;
      expect(instructions).toBeDefined();
      const lastInstruction = instructions![instructions!.length - 1];
      expect(lastInstruction.datacap_amount).toBe(2000);
      expect(lastInstruction.method).toBe('MDMA');
      expect(lastInstruction.status).toBe('GRANTED');

      vi.useRealTimers();
    });
  });

  describe('KYC Approval Endpoint', () => {
    it('should approve KYC with valid signature', async () => {
      const appId = 'test-app-kyc-001';

      await db.collection('applicationDetails').insertOne({
        id: appId,
        number: 1003,
        name: 'Test KYC App',
        organization: 'Test Org',
        address: APPLICANT_ADDRESS,
        github: 'test-github',
        allocationTrancheSchedule: 'test',
        datacap: 0,
        status: ApplicationStatus.KYC_PHASE,
        applicationInstructions: [],
      } as any);

      const tx = await new FilecoinTxBuilder().withChallenge(`KYC Override for ${appId}`).build();

      const response = await request(app)
        .post(`/api/v1/applications/${appId}/approveKYC`)
        .send({
          reviewerAddress: tx.address,
          reviewerPublicKey: tx.pubKeyBase64,
          signature: tx.transaction,
          reason: 'Test reason',
        })
        .expect(200);

      expect(response.body.status).toBe('200');
      expect(response.body.message).toContain('KYC result submitted successfully');
    });

    it('should reject KYC approval with invalid signature', async () => {
      const appId = 'test-app-kyc-002';

      await db.collection('applicationDetails').insertOne({
        id: appId,
        number: 1004,
        name: 'Test KYC App',
        organization: 'Test Org',
        address: APPLICANT_ADDRESS,
        github: 'test-github',
        allocationTrancheSchedule: 'test',
        datacap: 0,
        status: ApplicationStatus.KYC_PHASE,
        applicationInstructions: [],
      } as any);

      const response = await request(app)
        .post(`/api/v1/applications/${appId}/approveKYC`)
        .send({
          reviewerAddress: kycTransaction.address,
          reviewerPublicKey: kycTransaction.pubKeyBase64,
          signature: JSON.stringify({
            Message: 'invalid-message',
            Signature: { Data: 'invalid-signature' },
          }),
          reason: 'Test reason',
        })
        .expect(400);

      expect(response.body.status).toBe('400');
    });

    it('should reject KYC approval from non-governance team member', async () => {
      const appId = 'test-app-kyc-003';

      await db.collection('applicationDetails').insertOne({
        id: appId,
        number: 1005,
        name: 'Test KYC App',
        organization: 'Test Org',
        address: APPLICANT_ADDRESS,
        github: 'test-github',
        allocationTrancheSchedule: 'test',
        datacap: 0,
        status: ApplicationStatus.KYC_PHASE,
        applicationInstructions: [],
      } as any);

      // Create transaction with different private key (non-governance member)
      const nonGovTx = await new FilecoinTxBuilder()
        .withPrivateKeyHex('8f6a1c0d3b2e9f71c4d2a1b0e9f8c7d6b5a49382716f5e4d3c2b1a0918273645')
        .withChallenge(`KYC Override for ${appId}`)
        .build();

      const response = await request(app)
        .post(`/api/v1/applications/${appId}/approveKYC`)
        .send({
          reviewerAddress: nonGovTx.address,
          reviewerPublicKey: nonGovTx.pubKeyBase64,
          signature: nonGovTx.transaction,
          reason: 'Test reason',
        })
        .expect(403);

      expect(response.body.status).toBe('403');
      expect(response.body.message).toBe('Bad Permissions');
    });
  });

  describe('Governance Review Approval Endpoint', () => {
    beforeEach(async () => {
      // Helper to create application in GOVERNANCE_REVIEW_PHASE
      await db.collection('applicationDetails').insertOne({
        id: 'test-gov-001',
        number: 2001,
        name: 'Test Gov App',
        organization: 'Test Org',
        address: APPLICANT_ADDRESS,
        github: 'test-github',
        allocationTrancheSchedule: 'test',
        datacap: 0,
        status: ApplicationStatus.GOVERNANCE_REVIEW_PHASE,
        applicationInstructions: [
          {
            method: '',
            datacap_amount: 5,
            startTimestamp: Date.now(),
            status: 'PENDING',
          },
        ],
      } as any);
    });

    it('should approve governance review with valid signature', async () => {
      const tx = await new FilecoinTxBuilder()
        .withChallenge('Governance approve test-gov-001 500 RKH')
        .build();

      const response = await request(app)
        .post('/api/v1/applications/test-gov-001/approveGovernanceReview')
        .send({
          result: 'approve',
          details: {
            reviewerAddress: tx.address,
            reviewerPublicKey: tx.pubKeyBase64,
            finalDataCap: 500,
            allocatorType: 'RKH',
          },
          signature: tx.transaction,
        })
        .expect(200);

      expect(response.body.status).toBe('200');
      expect(response.body.message).toContain('Governance Team Review result submitted successfully');
    });

    it('should reject governance review with invalid signature', async () => {
      const response = await request(app)
        .post('/api/v1/applications/test-gov-001/approveGovernanceReview')
        .send({
          result: 'approve',
          details: {
            reviewerAddress: governanceTeamAddress,
            reviewerPublicKey: kycTransaction.pubKeyBase64,
            finalDataCap: 500,
            allocatorType: 'RKH',
          },
          signature: JSON.stringify({
            Message: 'wrong-challenge',
            Signature: { Data: 'invalid' },
          }),
        })
        .expect(400);

      expect(response.body.status).toBe('400');
    });
  });

  describe('KYC Revocation', () => {
    it('should revoke KYC approval', async () => {
      const appId = 'test-revoke-001';

      // Create application in GOVERNANCE_REVIEW_PHASE (already KYC approved)
      await db.collection('applicationDetails').insertOne({
        id: appId,
        number: 3001,
        name: 'Test Revoke App',
        organization: 'Test Org',
        address: APPLICANT_ADDRESS,
        github: 'test-github',
        allocationTrancheSchedule: 'test',
        datacap: 0,
        status: ApplicationStatus.GOVERNANCE_REVIEW_PHASE,
        applicationInstructions: [],
      } as any);

      const tx = await new FilecoinTxBuilder().withChallenge(`KYC Revoke for ${appId}`).build();

      const response = await request(app)
        .post(`/api/v1/applications/${appId}/revokeKYC`)
        .send({
          reviewerAddress: tx.address,
          reviewerPublicKey: tx.pubKeyBase64,
          signature: tx.transaction,
        })
        .expect(200);

      expect(response.body.status).toBe('200');
      expect(response.body.message).toContain('Phase changed successfully');
    });
  });

  describe('Get Applications Endpoint', () => {
    beforeEach(async () => {
      // Create multiple applications for querying
      await db.collection('applicationDetails').insertMany([
        {
          id: 'query-app-001',
          number: 4001,
          name: 'Query Test App 1',
          organization: 'Test Org 1',
          address: 'address1',
          github: 'github1',
          allocationTrancheSchedule: 'schedule1',
          datacap: 100,
          status: ApplicationStatus.KYC_PHASE,
        },
        {
          id: 'query-app-002',
          number: 4002,
          name: 'Query Test App 2',
          organization: 'Test Org 2',
          address: 'address2',
          github: 'github2',
          allocationTrancheSchedule: 'schedule2',
          datacap: 200,
          status: ApplicationStatus.GOVERNANCE_REVIEW_PHASE,
        },
        {
          id: 'query-app-003',
          number: 4003,
          name: 'Query Test App 3',
          organization: 'Test Org 3',
          address: 'address3',
          github: 'github3',
          allocationTrancheSchedule: 'schedule3',
          datacap: 300,
          status: ApplicationStatus.DC_ALLOCATED,
        },
      ] as any);
    });

    it('should get all applications with pagination', async () => {
      const response = await request(app)
        .get('/api/v1/applications')
        .query({ page: 1, limit: 10 })
        .expect(200);

      expect(response.body.status).toBe('200');
      expect(response.body.message).toContain('Retrieved allocators applications');
      expect(response.body.data).toBeDefined();
    });

    it('should filter applications by status', async () => {
      const response = await request(app)
        .get('/api/v1/applications')
        .query({ status: [ApplicationStatus.KYC_PHASE] })
        .expect(200);

      expect(response.body.status).toBe('200');
      expect(response.body.data).toBeDefined();
    });

    it('should handle invalid query parameters', async () => {
      const response = await request(app)
        .get('/api/v1/applications')
        .query({ page: -1 })
        .expect(400);

      expect(response.body.status).toBe('400');
      expect(response.body.message).toContain('Invalid query parameters');
    });
  });
});
