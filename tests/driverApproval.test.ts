import { isApprovedDriver } from '../src/utils/helpers';
import { findNearbyDrivers } from '../src/services/rideMatching';
import { store } from '../src/models';
import type { DriverInfo, User } from '../src/types';

// Going online is gated in three places that used to disagree with each other:
// REST /drivers/online read licenseVerified, WS ride_accept read
// applicationStatus, and WS driver_online checked neither. The consequences
// were real: a driver approved before applicationStatus existed was refused at
// ride_accept, and an unapproved driver could go online over the socket and
// appear as an available car the passenger could never actually get.
// All three now share isApprovedDriver, so these lock the semantics down.

const baseInfo = (over: Partial<DriverInfo> = {}): DriverInfo => ({
  vehicleType: 'economy',
  brand: 'Toyota',
  model: 'Prius',
  color: 'White',
  number: 'AA1234BB',
  vehicleYear: 2018,
  licenseVerified: false,
  isOnline: false,
  ...over,
});

describe('isApprovedDriver', () => {
  it('rejects a driver with no driverInfo at all', () => {
    expect(isApprovedDriver(undefined)).toBe(false);
  });

  it('rejects a fresh application awaiting review', () => {
    expect(isApprovedDriver(baseInfo({ applicationStatus: 'pending' }))).toBe(false);
  });

  it('rejects a rejected application even if licenseVerified was left true', () => {
    expect(
      isApprovedDriver(baseInfo({ applicationStatus: 'rejected', licenseVerified: true }))
    ).toBe(false);
  });

  it('accepts an approved application', () => {
    expect(
      isApprovedDriver(baseInfo({ applicationStatus: 'approved', licenseVerified: true }))
    ).toBe(true);
  });

  // The legacy case: approved before applicationStatus was introduced, so the
  // field is simply absent. Reading it strictly locked these drivers out of
  // accepting any ride.
  it('accepts a legacy record with licenseVerified and no applicationStatus', () => {
    expect(isApprovedDriver(baseInfo({ licenseVerified: true }))).toBe(true);
  });

  it('rejects a legacy record that was never verified', () => {
    expect(isApprovedDriver(baseInfo())).toBe(false);
  });
});

describe('findNearbyDrivers approval filter', () => {
  const at = { lat: 52.23, lng: 21.01 };

  const mkDriver = (uid: string, info: Partial<DriverInfo>): User => ({
    uid,
    role: 'driver',
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    driverInfo: baseInfo({ isOnline: true, lastLocation: at, ...info }),
  });

  beforeAll(async () => {
    await store().saveUser(mkDriver('d_approved', { applicationStatus: 'approved', licenseVerified: true }));
    await store().saveUser(mkDriver('d_legacy', { licenseVerified: true }));
    await store().saveUser(mkDriver('d_pending', { applicationStatus: 'pending' }));
    // Approved, went online, then an admin rejected them — isOnline stays true
    // in the store until the socket reconnects.
    await store().saveUser(mkDriver('d_rejected_while_online', { applicationStatus: 'rejected', licenseVerified: true }));
  });

  it('lists only approved drivers, including legacy records', async () => {
    const uids = (await findNearbyDrivers(at)).map((r) => r.driver.uid);
    expect(uids).toContain('d_approved');
    expect(uids).toContain('d_legacy');
    expect(uids).not.toContain('d_pending');
    expect(uids).not.toContain('d_rejected_while_online');
  });
});
