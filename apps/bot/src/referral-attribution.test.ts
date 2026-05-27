// Unit tests for writeReferralAcquisitionSource. Mocks prisma at the module
// boundary — we only need to pin the where/data shape passed to updateMany
// and the error-swallow contract.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { writeReferralAcquisitionSource } from './referral-attribution';

const updateMany = vi.fn();
const fakePrisma = { userProfile: { updateMany } } as never;

beforeEach(() => {
  updateMany.mockReset();
});

describe('writeReferralAcquisitionSource', () => {
  it('writes referral source with bot medium and refCode', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await writeReferralAcquisitionSource(fakePrisma, 'invitee_42', 'CODE_X');

    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ userId: 'invitee_42', firstAcquisitionSource: null });
    expect(call.data.firstAcquisitionSource).toBe('referral');
    expect(call.data.firstAcquisitionMedium).toBe('bot');
    expect(call.data.firstAcquisitionRef).toBe('CODE_X');
    expect(call.data.firstAcquisitionAt).toBeInstanceOf(Date);
  });

  it('is first-touch idempotent (updateMany filters WHERE firstAcquisitionSource IS NULL)', async () => {
    // Server-side updateMany returns count=0 when no rows match → no error,
    // helper still resolves cleanly.
    updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      writeReferralAcquisitionSource(fakePrisma, 'invitee_42', 'CODE_X'),
    ).resolves.toBeUndefined();
  });

  it('swallows prisma errors (logger.warn, no rethrow)', async () => {
    updateMany.mockRejectedValueOnce(new Error('db down'));

    await expect(
      writeReferralAcquisitionSource(fakePrisma, 'invitee_42', 'CODE_X'),
    ).resolves.toBeUndefined();
  });
});
