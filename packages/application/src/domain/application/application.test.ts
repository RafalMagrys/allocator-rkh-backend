import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import { ApplicationInstructionStatus, ApplicationStatus, DatacapAllocator } from './application';
import { ApplicationEdited, RKHApprovalCompleted } from './application.events';
import { ApplicationError, zuluToEpoch } from '@filecoin-plus/core';
import { StatusCodes } from 'http-status-codes';
import { ApplicationPullRequestFile } from '@src/application/services/pull-request.types';
import { AllocatorType } from '../types';

describe('Application', () => {
  const fixtureApplicationParams = {
    applicationId: '123',
    applicationNumber: 123,
    applicantName: 'John Doe',
    applicantAddress: '123',
    applicantOrgName: 'Org',
    applicantOrgAddresses: '123',
    allocationTrancheSchedule: '123',
    allocationAudit: '123',
    allocationDistributionRequired: '123',
    allocationRequiredStorageProviders: '123',
    bookkeepingRepo: '123',
    allocationRequiredReplicas: '123',
    datacapAllocationLimits: '123',
    applicantGithubHandle: '123',
    otherGithubHandles: ['123'],
    onChainAddressForDataCapAllocation: '123',
  };

  /**
   * all fields are different from fixtureApplicationParams to be sure all fields are being set correctly
   */
  const fixtureApplicationPullRequestFile = {
    application_number: 456,
    address: '456',
    name: 'Jane Doe',
    organization: 'Org',
    associated_org_addresses: '456',
    metapathway_type: 'MDMA',
    ma_address: '456',
    allocator_id: '456',
    application: {
      allocations: ['456'],
      audit: ['456'],
      tranche_schedule: 'Monthly',
      distribution: ['456'],
      required_sps: '10',
      required_replicas: '3',
      tooling: ['smart_contract_allocator'],
      max_DC_client: '1',
      github_handles: ['456'],
      allocation_bookkeeping: 'https://github.com/test/repo',
      client_contract_address: '456',
    },
    history: {
      '456': '2021-01-01T00:00:00.000Z',
    },
    audits: [
      {
        started: '2021-01-01T00:00:00.000Z',
        ended: '2021-01-01T00:00:00.000Z',
        dc_allocated: '2021-01-01T00:00:00.000Z',
        datacap_amount: 456,
        outcome: 'GRANTED',
      },
    ],
    old_allocator_id: '456',
    pathway_addresses: {
      msig: 'f081',
      signers: ['f081'],
    },
  } satisfies ApplicationPullRequestFile;

  it('should create an application via constructor', () => {
    const application = new DatacapAllocator('123');
    expect(application.guid).toBe('123');
  });

  describe('completeRKHApproval', () => {
    const fixtureNow = new Date('2021-01-01T00:00:00.000Z');
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;
    let applyRKHApprovalCompletedSpy: MockInstance;

    beforeAll(() => {
      vi.useFakeTimers();
      vi.setSystemTime(fixtureNow);
    });

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      applyChangeSpy = vi.spyOn(application, 'applyChange');
      applyRKHApprovalCompletedSpy = vi.spyOn(application, 'applyRKHApprovalCompleted');
      application.applicationInstructions = [
        {
          method: 'RKH_ALLOCATOR',
          datacap_amount: 123,
          startTimestamp: 123,
          endTimestamp: 123,
        },
      ];
      application.applicationStatus = ApplicationStatus.RKH_APPROVAL_PHASE;
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('should update application correctly', () => {
      application.completeRKHApproval();

      expect(application.applicationStatus).toEqual(ApplicationStatus.DC_ALLOCATED);
      expect(application.allocationTooling).toEqual([]);
      expect(application.pathway).toEqual('RKH');
      expect(application.ma_address).toEqual(application.rkh_address);
      expect(application.applicationInstructions[0].allocatedTimestamp).toEqual(
        fixtureNow.getTime(),
      );
      expect(application.applicationInstructions[0].status).toEqual(
        ApplicationInstructionStatus.GRANTED,
      );
      expect(application.applicationInstructions[0].datacap_amount).toEqual(123);
      expect(application.status['DC Allocated']).toEqual(fixtureNow.getTime());
    });

    it('should apply change correctly', () => {
      application.completeRKHApproval();

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy).toHaveBeenCalledWith(expect.any(RKHApprovalCompleted));
      expect(applyChangeSpy).toHaveBeenCalledWith({
        aggregateId: application.guid,
        aggregateName: 'allocator',
        eventName: RKHApprovalCompleted.name,
        timestamp: fixtureNow,
        source: 'api',
        applicationInstructions: application.applicationInstructions,
      });
    });

    it('should complete RKH approval successfully with correct aggregate apply method', () => {
      application.completeRKHApproval();

      expect(applyRKHApprovalCompletedSpy).toHaveBeenCalledTimes(1);
      expect(applyRKHApprovalCompletedSpy).toHaveBeenCalledWith({
        aggregateName: 'allocator',
        eventName: RKHApprovalCompleted.name,
        timestamp: fixtureNow,
        aggregateId: application.guid,
        source: 'api',
        applicationInstructions: application.applicationInstructions,
      });
    });

    it.each`
      applicationStatus
      ${ApplicationStatus.KYC_PHASE}
      ${ApplicationStatus.GOVERNANCE_REVIEW_PHASE}
      ${ApplicationStatus.META_APPROVAL_PHASE}
      ${ApplicationStatus.APPROVED}
      ${ApplicationStatus.REJECTED}
      ${ApplicationStatus.IN_REFRESH}
      ${ApplicationStatus.DC_ALLOCATED}
      ${ApplicationStatus.REJECTED}
    `(
      'should throw an error if $applicationStatus is not allowed to complete RKH approval',
      ({ applicationStatus }) => {
        application.applicationStatus = applicationStatus;
        expect(() => application.completeRKHApproval()).toThrow(
          new ApplicationError(
            StatusCodes.BAD_REQUEST,
            '5308',
            'Invalid operation for the current phase',
          ),
        );
      },
    );
  });

  describe('edit', () => {
    const fixtureNow = new Date('2021-01-01T00:00:00.000Z');
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;
    let applyApplicationEditedSpy: MockInstance;

    beforeAll(() => {
      vi.useFakeTimers();
      vi.setSystemTime(fixtureNow);
    });

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      applyChangeSpy = vi.spyOn(application, 'applyChange');
      applyApplicationEditedSpy = vi.spyOn(application, 'applyApplicationEdited');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('should edit the application correctly for RKH approval phase', () => {
      application.applicationStatus = ApplicationStatus.RKH_APPROVAL_PHASE;
      application.edit(fixtureApplicationPullRequestFile);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy).toHaveBeenCalledWith(expect.any(ApplicationEdited));
      expect(applyApplicationEditedSpy).toHaveBeenCalledTimes(1);
      expect(applyApplicationEditedSpy).toHaveBeenCalledWith(expect.any(ApplicationEdited));
      expect(applyChangeSpy).toHaveBeenCalledWith({
        aggregateId: application.guid,
        aggregateName: 'allocator',
        eventName: ApplicationEdited.name,
        timestamp: fixtureNow,
        source: 'api',
        file: {
          application_number: fixtureApplicationPullRequestFile.application_number,
          address: fixtureApplicationPullRequestFile.address,
          name: fixtureApplicationPullRequestFile.name,
          organization: fixtureApplicationPullRequestFile.organization,
          associated_org_addresses: fixtureApplicationPullRequestFile.associated_org_addresses,
          metapathway_type: fixtureApplicationPullRequestFile.metapathway_type,
          ma_address: fixtureApplicationPullRequestFile.ma_address,
          allocator_id: fixtureApplicationPullRequestFile.allocator_id,
          application: {
            allocations: fixtureApplicationPullRequestFile.application.allocations,
            audit: fixtureApplicationPullRequestFile.application.audit,
            tranche_schedule: fixtureApplicationPullRequestFile.application.tranche_schedule,
            distribution: fixtureApplicationPullRequestFile.application.distribution,
            required_sps: fixtureApplicationPullRequestFile.application.required_sps,
            required_replicas: fixtureApplicationPullRequestFile.application.required_replicas,
            tooling: fixtureApplicationPullRequestFile.application.tooling,
            max_DC_client: fixtureApplicationPullRequestFile.application.max_DC_client,
            github_handles: fixtureApplicationPullRequestFile.application.github_handles,
            allocation_bookkeeping:
              fixtureApplicationPullRequestFile.application.allocation_bookkeeping,
            client_contract_address:
              fixtureApplicationPullRequestFile.application.client_contract_address,
          },
          history: fixtureApplicationPullRequestFile.history,
          audits: fixtureApplicationPullRequestFile.audits,
          old_allocator_id: fixtureApplicationPullRequestFile.old_allocator_id,
          pathway_addresses: fixtureApplicationPullRequestFile.pathway_addresses,
        },
      });
    });

    it('should edit the application correctly for Meta approval phase', () => {
      application.applicationStatus = ApplicationStatus.META_APPROVAL_PHASE;
      application.isMetaAllocator = true;
      application.isMDMA = true;
      application.edit(fixtureApplicationPullRequestFile);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy).toHaveBeenCalledWith(expect.any(ApplicationEdited));
      expect(applyApplicationEditedSpy).toHaveBeenCalledTimes(1);
      expect(applyApplicationEditedSpy).toHaveBeenCalledWith(expect.any(ApplicationEdited));
      expect(application.pathway).toEqual(fixtureApplicationPullRequestFile.metapathway_type);
      expect(application.ma_address).toEqual(fixtureApplicationPullRequestFile.ma_address);
      expect(application.allocationTooling).toEqual(['smart_contract_allocator']);
      expect(application.allocationStandardizedAllocations).toEqual(
        fixtureApplicationPullRequestFile.application.allocations,
      );
      expect(application.allocationAudit).toEqual(
        fixtureApplicationPullRequestFile.application.audit[0],
      );
      expect(application.allocationDistributionRequired).toEqual(
        fixtureApplicationPullRequestFile.application.distribution[0],
      );
      expect(application.allocationTrancheSchedule).toEqual(
        fixtureApplicationPullRequestFile.application.tranche_schedule,
      );
      expect(application.allocationRequiredReplicas).toEqual(
        fixtureApplicationPullRequestFile.application.required_replicas,
      );
      expect(application.allocationRequiredStorageProviders).toEqual(
        fixtureApplicationPullRequestFile.application.required_sps,
      );
      expect(application.allocationMaxDcClient).toEqual(
        fixtureApplicationPullRequestFile.application.max_DC_client,
      );
      expect(application.applicantGithubHandle).toEqual(
        fixtureApplicationPullRequestFile.application.github_handles[0],
      );
      expect(application.onChainAddressForDataCapAllocation).toEqual(
        fixtureApplicationPullRequestFile.application.client_contract_address,
      );
      expect(application.allocationBookkeepingRepo).toEqual(
        fixtureApplicationPullRequestFile.application.allocation_bookkeeping,
      );
      expect(application.allocatorMultisigAddress).toEqual(
        fixtureApplicationPullRequestFile.pathway_addresses?.msig,
      );
      expect(application.allocatorMultisigSigners).toEqual(
        fixtureApplicationPullRequestFile.pathway_addresses?.signers,
      );
      expect(application.applicationInstructions).toEqual(
        fixtureApplicationPullRequestFile.audits.map(ao => ({
          method: (fixtureApplicationPullRequestFile.metapathway_type as AllocatorType) || '',
          startTimestamp: zuluToEpoch(ao.started),
          endTimestamp: zuluToEpoch(ao.ended),
          allocatedTimestamp: zuluToEpoch(ao.dc_allocated),
          status: ao.outcome || 'PENDING',
          datacap_amount: ao.datacap_amount || 0,
        })),
      );
    });

    it('should handle defaults for missing fields in meta approval phase', () => {
      application.allocationTooling = [];
      application.isMetaAllocator = true;
      application.isMDMA = true;
      application.pathway = 'TEST';
      application.ma_address = 'TEST';

      application.edit({
        ...fixtureApplicationPullRequestFile,
        ma_address: undefined,
        metapathway_type: undefined,
      });

      expect(application.pathway).toEqual('MDMA');
      expect(application.ma_address).toEqual(application.mdma_address);
      expect(application.allocationTooling).toEqual(['smart_contract_allocator']);
    });

    it('should set default values for missing fields in RKH approval phase', () => {
      application.allocationTooling = [];
      application.pathway = 'TEST';
      application.ma_address = 'TEST';
      application.isMetaAllocator = false;
      application.isMDMA = true;

      application.edit({
        ...fixtureApplicationPullRequestFile,
        metapathway_type: undefined,
        ma_address: undefined,
      });

      expect(application.pathway).toEqual('RKH');
      expect(application.ma_address).toEqual(application.rkh_address);
      expect(application.allocationTooling).toEqual([]);
    });
  });

  describe('create', () => {
    const fixtureNow = new Date('2021-01-01T00:00:00.000Z');
    let applyChangeSpy: MockInstance;
    let application: DatacapAllocator;

    beforeAll(() => {
      vi.useFakeTimers();
      vi.setSystemTime(fixtureNow);
    });

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('should create application with correct initial values', () => {
      const newApp = DatacapAllocator.create(fixtureApplicationParams);

      expect(newApp.guid).toBe(fixtureApplicationParams.applicationId);
      expect(newApp.applicationNumber).toBe(fixtureApplicationParams.applicationNumber);
      expect(newApp.applicantName).toBe(fixtureApplicationParams.applicantName);
      expect(newApp.applicantAddress).toBe(fixtureApplicationParams.applicantAddress);
      expect(newApp.applicantOrgName).toBe(fixtureApplicationParams.applicantOrgName);
      expect(newApp.applicantOrgAddresses).toBe(fixtureApplicationParams.applicantOrgAddresses);
      expect(newApp.allocationTrancheSchedule).toBe(fixtureApplicationParams.allocationTrancheSchedule);
      expect(newApp.allocationAudit).toBe(fixtureApplicationParams.allocationAudit);
      expect(newApp.allocationDistributionRequired).toBe(
        fixtureApplicationParams.allocationDistributionRequired,
      );
      expect(newApp.allocationRequiredStorageProviders).toBe(
        fixtureApplicationParams.allocationRequiredStorageProviders,
      );
      expect(newApp.allocationBookkeepingRepo).toBe(fixtureApplicationParams.bookkeepingRepo);
      expect(newApp.allocationRequiredReplicas).toBe(
        fixtureApplicationParams.allocationRequiredReplicas,
      );
      expect(newApp.allocationDatacapAllocationLimits).toBe(
        fixtureApplicationParams.datacapAllocationLimits,
      );
      expect(newApp.applicantGithubHandle).toBe(fixtureApplicationParams.applicantGithubHandle);
      expect(newApp.onChainAddressForDataCapAllocation).toBe(
        fixtureApplicationParams.onChainAddressForDataCapAllocation,
      );
    });

    it('should initialize application with KYC_PHASE status', () => {
      const newApp = DatacapAllocator.create(fixtureApplicationParams);

      expect(newApp.applicationStatus).toBe(ApplicationStatus.KYC_PHASE);
    });

    it('should initialize application with one pending instruction', () => {
      const newApp = DatacapAllocator.create(fixtureApplicationParams);

      expect(newApp.applicationInstructions).toHaveLength(1);
      expect(newApp.applicationInstructions[0]).toMatchObject({
        method: '',
        datacap_amount: 5,
        status: ApplicationInstructionStatus.PENDING,
      });
      expect(newApp.applicationInstructions[0].startTimestamp).toBeDefined();
    });

    it('should set default values correctly on creation', () => {
      const newApp = DatacapAllocator.create(fixtureApplicationParams);

      // Verify status object is initialized
      expect(newApp.status).toBeDefined();
      expect(newApp.status['Application Submitted']).toBeNull();
      expect(newApp.status['KYC Submitted']).toBeNull();
      expect(newApp.status['Approved']).toBeNull();
      expect(newApp.status['Declined']).toBeNull();
      expect(newApp.status['DC Allocated']).toBeNull();

      // Verify RKH approval defaults
      expect(newApp.rkhApprovalThreshold).toBe(2);
      expect(newApp.rkhApprovals).toEqual([]);
    });
  });

  describe('setAllocatorMultisig', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should set allocator multisig details correctly', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      application.setAllocatorMultisig('f01234', 'f2address', 2, ['signer1', 'signer2']);

      expect(application.allocatorActorId).toBe('f01234');
      expect(application.allocatorMultisigAddress).toBe('f2address');
      expect(application.allocatorMultisigThreshold).toBe(2);
      expect(application.allocatorMultisigSigners).toEqual(['signer1', 'signer2']);
    });

    it('should emit AllocatorMultisigUpdated event', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      application.setAllocatorMultisig('f01234', 'f2address', 2, ['signer1', 'signer2']);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('AllocatorMultisigUpdated');
    });

    it('should throw error if not in KYC_PHASE', () => {
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;

      expect(() =>
        application.setAllocatorMultisig('f01234', 'f2address', 2, ['signer1', 'signer2']),
      ).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('setApplicationPullRequest', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should set pull request for new application (not refresh)', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      application.setApplicationPullRequest(123, 'https://github.com/pr/123', 456, false);

      expect(application.applicationPullRequest).toMatchObject({
        prNumber: 123,
        prUrl: 'https://github.com/pr/123',
        commentId: 456,
      });
    });

    it('should emit ApplicationPullRequestUpdated event with KYC_PHASE for new application', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      application.setApplicationPullRequest(123, 'https://github.com/pr/123', 456, false);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      const event = applyChangeSpy.mock.calls[0][0];
      expect(event.eventName).toBe('ApplicationPullRequestUpdated');
      expect(event.status).toBe(ApplicationStatus.KYC_PHASE);
    });

    it('should set pull request for refresh application', () => {
      application.applicationStatus = ApplicationStatus.DC_ALLOCATED;

      application.setApplicationPullRequest(789, 'https://github.com/pr/789', 101, true);

      expect(application.applicationPullRequest).toMatchObject({
        prNumber: 789,
        prUrl: 'https://github.com/pr/789',
        commentId: 101,
      });
    });

    it('should emit ApplicationPullRequestUpdated event with GOVERNANCE_REVIEW_PHASE for refresh', () => {
      application.applicationStatus = ApplicationStatus.DC_ALLOCATED;

      application.setApplicationPullRequest(789, 'https://github.com/pr/789', 101, true);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      const event = applyChangeSpy.mock.calls[0][0];
      expect(event.eventName).toBe('ApplicationPullRequestUpdated');
      expect(event.status).toBe(ApplicationStatus.GOVERNANCE_REVIEW_PHASE);
    });

    it('should throw error if not in KYC_PHASE for new application', () => {
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;

      expect(() =>
        application.setApplicationPullRequest(123, 'https://github.com/pr/123', 456, false),
      ).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });

    it('should throw error if not in DC_ALLOCATED for refresh application', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() =>
        application.setApplicationPullRequest(789, 'https://github.com/pr/789', 101, true),
      ).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('approveKYC', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;
    const kycData = {
      message: 'KYC approved',
    };

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.KYC_PHASE;
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should transition to GOVERNANCE_REVIEW_PHASE', () => {
      application.approveKYC(kycData);

      expect(application.applicationStatus).toBe(ApplicationStatus.GOVERNANCE_REVIEW_PHASE);
    });

    it('should emit KYCApproved and GovernanceReviewStarted events', () => {
      application.approveKYC(kycData);

      expect(applyChangeSpy).toHaveBeenCalledTimes(2);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('KYCApproved');
      expect(applyChangeSpy.mock.calls[1][0].eventName).toBe('GovernanceReviewStarted');
    });

    it('should throw error if not in KYC_PHASE', () => {
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;

      expect(() => application.approveKYC(kycData)).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('revokeKYC', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should revoke KYC and stay in GOVERNANCE_REVIEW_PHASE', () => {
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;
      application.status['KYC Submitted'] = Date.now();

      application.revokeKYC();

      expect(application.applicationStatus).toBe(ApplicationStatus.GOVERNANCE_REVIEW_PHASE);
      expect(application.status['KYC Submitted']).toBeNull();
    });

    it('should emit KYCRevoked event', () => {
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;

      application.revokeKYC();

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('KYCRevoked');
    });

    it('should throw error if not in GOVERNANCE_REVIEW_PHASE', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() => application.revokeKYC()).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('rejectKYC', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;
    const kycRejectedData = {
      message: 'KYC rejected',
    };

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.KYC_PHASE;
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should reject KYC and set KYC Failed timestamp', () => {
      const beforeTime = Date.now();
      application.rejectKYC(kycRejectedData);
      const afterTime = Date.now();

      expect(application.status['KYC Failed']).toBeGreaterThanOrEqual(beforeTime);
      expect(application.status['KYC Failed']).toBeLessThanOrEqual(afterTime);
    });

    it('should emit KYCRejected event', () => {
      application.rejectKYC(kycRejectedData);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('KYCRejected');
    });

    it('should throw error if not in KYC_PHASE', () => {
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;

      expect(() => application.rejectKYC(kycRejectedData)).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('approveGovernanceReview', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;
    const governanceData = {
      finalDataCap: 1000,
      isMDMAAllocator: false,
    };
    const allocationPath = {
      pathway: 'RKH',
      address: 'f080',
      isMetaAllocator: false,
    };

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;
      application.applicationInstructions = [
        {
          method: '',
          datacap_amount: 5,
          startTimestamp: Date.now(),
          status: ApplicationInstructionStatus.PENDING,
        },
      ];
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should approve governance review for RKH MDMA path (direct allocation)', () => {
      const govDataWithMDMA = { ...governanceData, isMDMAAllocator: true };
      application.approveGovernanceReview(govDataWithMDMA, allocationPath);

      expect(application.applicationStatus).toBe(ApplicationStatus.DC_ALLOCATED);
      expect(application.pathway).toBe('RKH');
      expect(application.ma_address).toBe('f080');
      expect(application.isMetaAllocator).toBe(false);
      expect(application.allocationTooling).toEqual([]);
      expect(application.applicationInstructions[0].method).toBe('RKH');
      expect(application.applicationInstructions[0].datacap_amount).toBe(1000);
      expect(application.applicationInstructions[0].status).toBe(ApplicationInstructionStatus.GRANTED);
    });

    it('should approve governance review for RKH path with multisig approval needed', () => {
      const govDataWithoutMDMA = { ...governanceData, isMDMAAllocator: undefined };

      application.approveGovernanceReview(govDataWithoutMDMA, allocationPath);

      expect(application.applicationStatus).toBe(ApplicationStatus.RKH_APPROVAL_PHASE);
      expect(application.pathway).toBe('RKH');
      expect(application.ma_address).toBe('f080');
    });

    it('should approve governance review for Meta allocator MDMA (direct allocation)', () => {
      const metaData = { ...governanceData, isMDMAAllocator: true };
      const metaPath = {
        pathway: 'MDMA',
        address: 'f410fw325e6novwl57jcsbhz6koljylxuhqq5jnp5ftq',
        isMetaAllocator: true,
      };

      application.approveGovernanceReview(metaData, metaPath);

      expect(application.applicationStatus).toBe(ApplicationStatus.DC_ALLOCATED);
      expect(application.pathway).toBe('MDMA');
      expect(application.isMetaAllocator).toBe(true);
      expect(application.allocationTooling).toEqual(['smart_contract_allocator']);
      expect(application.applicationInstructions[0].status).toBe(ApplicationInstructionStatus.GRANTED);
    });

    it('should approve governance review for Meta allocator with on-chain approval needed', () => {
      const metaData = { ...governanceData, isMDMAAllocator: false };
      const metaPath = {
        pathway: 'MDMA',
        address: 'f410fw325e6novwl57jcsbhz6koljylxuhqq5jnp5ftq',
        isMetaAllocator: true,
      };

      application.approveGovernanceReview(metaData, metaPath);

      expect(application.applicationStatus).toBe(ApplicationStatus.META_APPROVAL_PHASE);
      expect(application.pathway).toBe('MDMA');
      expect(application.isMetaAllocator).toBe(true);
    });

    it('should emit GovernanceReviewApproved event', () => {
      application.approveGovernanceReview(governanceData, allocationPath);

      const governanceEvent = applyChangeSpy.mock.calls.find(
        call => call[0].eventName === 'GovernanceReviewApproved',
      );
      expect(governanceEvent).toBeDefined();
    });

    it('should update instruction with datacap amount and method', () => {
      application.approveGovernanceReview(governanceData, allocationPath);

      expect(application.applicationInstructions[0].datacap_amount).toBe(1000);
      expect(application.applicationInstructions[0].method).toBe('RKH');
    });

    it('should throw error if not in GOVERNANCE_REVIEW_PHASE', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() => application.approveGovernanceReview(governanceData, allocationPath)).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('rejectGovernanceReview', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;
    const rejectionData = {
      message: 'Governance review rejected',
    };

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.GOVERNANCE_REVIEW_PHASE;
      application.applicationInstructions = [
        {
          method: 'RKH',
          datacap_amount: 100,
          startTimestamp: Date.now(),
          status: ApplicationInstructionStatus.PENDING,
        },
      ];
      application.allocatorActorId = 'f01234';
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should reject governance review and transition to REJECTED status', () => {
      application.rejectGovernanceReview(rejectionData);

      expect(application.applicationStatus).toBe(ApplicationStatus.REJECTED);
      expect(application.applicationInstructions[0].status).toBe(ApplicationInstructionStatus.DENIED);
    });

    it('should emit GovernanceReviewRejected event', () => {
      application.rejectGovernanceReview(rejectionData);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('GovernanceReviewRejected');
    });

    it('should zero out allocatorActorId for rejected application', () => {
      application.rejectGovernanceReview(rejectionData);

      expect(application.allocatorActorId).toBe('f00000000');
    });

    it('should set Declined timestamp', () => {
      const beforeTime = Date.now();
      application.rejectGovernanceReview(rejectionData);
      const afterTime = Date.now();

      expect(application.status['Declined']).toBeGreaterThanOrEqual(beforeTime);
      expect(application.status['Declined']).toBeLessThanOrEqual(afterTime);
    });

    it('should throw error if not in GOVERNANCE_REVIEW_PHASE', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() => application.rejectGovernanceReview(rejectionData)).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('updateRKHApprovals', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.RKH_APPROVAL_PHASE;
      application.rkhApprovalThreshold = 2;
      application.rkhApprovals = [];
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should update RKH approvals when count changes', () => {
      application.updateRKHApprovals(123, ['signer1']);

      expect(application.rkhApprovals).toEqual(['signer1']);
      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit RKHApprovalsUpdated event', () => {
      application.updateRKHApprovals(123, ['signer1', 'signer2']);

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('RKHApprovalsUpdated');
    });

    it('should not emit event if approval count is same', () => {
      application.rkhApprovals = ['signer1'];

      application.updateRKHApprovals(123, ['signer1']);

      expect(applyChangeSpy).not.toHaveBeenCalled();
    });

    it('should transition to DC_ALLOCATED when threshold is met', () => {
      application.updateRKHApprovals(123, ['signer1', 'signer2']);

      expect(application.applicationStatus).toBe(ApplicationStatus.DC_ALLOCATED);
    });

    it('should stay in RKH_APPROVAL_PHASE when threshold is not met', () => {
      application.updateRKHApprovals(123, ['signer1']);

      expect(application.applicationStatus).toBe(ApplicationStatus.RKH_APPROVAL_PHASE);
    });

    it('should throw error if not in RKH_APPROVAL_PHASE', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() => application.updateRKHApprovals(123, ['signer1'])).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('completeMetaAllocatorApproval', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.META_APPROVAL_PHASE;
      application.applicationInstructions = [
        {
          method: 'MDMA',
          datacap_amount: 1000,
          startTimestamp: Date.now(),
          status: ApplicationInstructionStatus.PENDING,
        },
      ];
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should complete meta allocator approval successfully', async () => {
      await application.completeMetaAllocatorApproval(12345, '0xabcdef');

      expect(application.applicationStatus).toBe(ApplicationStatus.DC_ALLOCATED);
    });

    it('should emit MetaAllocatorApprovalCompleted event with block and tx hash', async () => {
      await application.completeMetaAllocatorApproval(12345, '0xabcdef');

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      const event = applyChangeSpy.mock.calls[0][0];
      expect(event.eventName).toBe('MetaAllocatorApprovalCompleted');
      expect(event.blockNumber).toBe(12345);
      expect(event.txHash).toBe('0xabcdef');
    });

    it('should set DC Allocated timestamp', async () => {
      const beforeTime = Date.now();
      await application.completeMetaAllocatorApproval(12345, '0xabcdef');
      const afterTime = Date.now();

      expect(application.status['DC Allocated']).toBeGreaterThanOrEqual(beforeTime);
      expect(application.status['DC Allocated']).toBeLessThanOrEqual(afterTime);
    });

    it('should throw error if not in META_APPROVAL_PHASE', async () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      await expect(application.completeMetaAllocatorApproval(12345, '0xabcdef')).rejects.toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('updateDatacapAllocation', () => {
    let application: DatacapAllocator;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationInstructions = [
        {
          method: 'RKH',
          datacap_amount: 100,
          startTimestamp: Date.now(),
          status: ApplicationInstructionStatus.PENDING,
        },
      ];
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should attempt to complete RKH approval when updating datacap', () => {
      application.applicationStatus = ApplicationStatus.RKH_APPROVAL_PHASE;
      const completeRKHSpy = vi.spyOn(application, 'completeRKHApproval');

      application.updateDatacapAllocation(500);

      expect(completeRKHSpy).toHaveBeenCalledTimes(1);
    });

    it('should not throw error if completeRKHApproval fails', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() => application.updateDatacapAllocation(500)).not.toThrow();
    });
  });

  describe('requestDatacapRefresh', () => {
    let application: DatacapAllocator;
    let applyChangeSpy: MockInstance;

    beforeEach(() => {
      application = DatacapAllocator.create(fixtureApplicationParams);
      application.applicationStatus = ApplicationStatus.DC_ALLOCATED;
      application.applicationInstructions = [
        {
          method: 'RKH',
          datacap_amount: 1000,
          startTimestamp: Date.now(),
          status: ApplicationInstructionStatus.GRANTED,
          allocatedTimestamp: Date.now(),
        },
      ];
      applyChangeSpy = vi.spyOn(application, 'applyChange');
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should transition to IN_REFRESH and then to GOVERNANCE_REVIEW_PHASE', () => {
      application.requestDatacapRefresh();

      expect(application.applicationStatus).toBe(ApplicationStatus.GOVERNANCE_REVIEW_PHASE);
    });

    it('should emit DatacapRefreshRequested event', () => {
      application.requestDatacapRefresh();

      expect(applyChangeSpy).toHaveBeenCalledTimes(1);
      expect(applyChangeSpy.mock.calls[0][0].eventName).toBe('DatacapRefreshRequested');
    });

    it('should create new instruction with doubled datacap amount', () => {
      application.requestDatacapRefresh();

      expect(application.applicationInstructions).toHaveLength(2);
      expect(application.applicationInstructions[1].datacap_amount).toBe(2000);
      expect(application.applicationInstructions[1].method).toBe('RKH');
      expect(application.applicationInstructions[1].status).toBe(ApplicationInstructionStatus.PENDING);
    });

    it('should maintain previous status timestamps', () => {
      const existingTimestamp = Date.now() - 1000;
      application.status['DC Allocated'] = existingTimestamp;

      application.requestDatacapRefresh();

      expect(application.status['DC Allocated']).toBe(existingTimestamp);
    });

    it('should throw error if not in DC_ALLOCATED status', () => {
      application.applicationStatus = ApplicationStatus.KYC_PHASE;

      expect(() => application.requestDatacapRefresh()).toThrow(
        new ApplicationError(
          StatusCodes.BAD_REQUEST,
          '5308',
          'Invalid operation for the current phase',
        ),
      );
    });
  });

  describe('grantCycle getter', () => {
    it('should return the number of grant cycles', () => {
      const application = DatacapAllocator.create(fixtureApplicationParams);
      application.grantCycles = [
        {
          id: 1,
          status: ApplicationInstructionStatus.GRANTED,
          pullRequest: {} as ApplicationPullRequest,
          instruction: {} as ApplicationInstruction,
        },
        {
          id: 2,
          status: ApplicationInstructionStatus.PENDING,
          pullRequest: {} as ApplicationPullRequest,
          instruction: {} as ApplicationInstruction,
        },
      ];

      expect(application.grantCycle).toBe(2);
    });

    it('should return 0 when no grant cycles exist', () => {
      const application = DatacapAllocator.create(fixtureApplicationParams);

      expect(application.grantCycle).toBe(0);
    });
  });
});
