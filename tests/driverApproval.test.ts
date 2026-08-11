import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { isApprovedDriver, driverApprovalStatus } from '../src/utils/helpers';
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

describe('driverApprovalStatus', () => {
  // The admin driver list reports the review state rather than a yes/no, and
  // used to compute the legacy fallback with its own copy of the rule. Both now
  // come from here, so the list can never disagree with the gates.
  it('reports the stored status when there is one', () => {
    expect(driverApprovalStatus(baseInfo({ applicationStatus: 'rejected' }))).toBe('rejected');
    expect(driverApprovalStatus(baseInfo({ applicationStatus: 'pending' }))).toBe('pending');
  });

  it('infers approved from a legacy licenseVerified record', () => {
    expect(driverApprovalStatus(baseInfo({ licenseVerified: true }))).toBe('approved');
  });

  it('treats a missing record as pending', () => {
    expect(driverApprovalStatus(undefined)).toBe('pending');
    expect(driverApprovalStatus(baseInfo())).toBe('pending');
  });

  it('agrees with isApprovedDriver on every shape', () => {
    const shapes: (DriverInfo | undefined)[] = [
      undefined,
      baseInfo(),
      baseInfo({ licenseVerified: true }),
      baseInfo({ applicationStatus: 'pending' }),
      baseInfo({ applicationStatus: 'approved' }),
      baseInfo({ applicationStatus: 'rejected', licenseVerified: true }),
    ];
    for (const info of shapes) {
      expect(isApprovedDriver(info)).toBe(driverApprovalStatus(info) === 'approved');
    }
  });
});

describe('switching into the driver role', () => {
  // Reading applicationStatus directly here refused a driver approved before
  // that field existed — they could not become a driver in the app at all,
  // which is the harshest version of this lockout.
  const app = createApp();

  const mkUser = (uid: string, info?: Partial<DriverInfo>): User => ({
    uid,
    role: 'passenger',
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(info ? { driverInfo: baseInfo(info) } : {}),
  });

  const authFor = (uid: string): { Authorization: string } => ({
    Authorization: `Bearer ${signToken({ uid, role: 'passenger' })}`,
  });

  it('lets a legacy approved driver switch to the driver role', async () => {
    await store().saveUser(mkUser('sw_legacy', { licenseVerified: true }));
    const res = await request(app)
      .post('/api/users/me/switch-role')
      .set(authFor('sw_legacy'))
      .send({ role: 'driver' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('driver');
  });

  it('lets an explicitly approved driver switch', async () => {
    await store().saveUser(
      mkUser('sw_approved', { applicationStatus: 'approved', licenseVerified: true })
    );
    const res = await request(app)
      .post('/api/users/me/switch-role')
      .set(authFor('sw_approved'))
      .send({ role: 'driver' });
    expect(res.status).toBe(200);
  });

  it('refuses an application still under review', async () => {
    await store().saveUser(mkUser('sw_pending', { applicationStatus: 'pending' }));
    const res = await request(app)
      .post('/api/users/me/switch-role')
      .set(authFor('sw_pending'))
      .send({ role: 'driver' });
    expect(res.status).toBe(400);
  });

  it('refuses a rejected application and someone who never applied', async () => {
    await store().saveUser(
      mkUser('sw_rejected', { applicationStatus: 'rejected', licenseVerified: true })
    );
    await store().saveUser(mkUser('sw_none'));
    for (const uid of ['sw_rejected', 'sw_none']) {
      const res = await request(app)
        .post('/api/users/me/switch-role')
        .set(authFor(uid))
        .send({ role: 'driver' });
      expect(res.status).toBe(400);
    }
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

describe('POST /api/drivers/register', () => {
  const app = createApp();
  const authFor = (uid: string): { Authorization: string } => ({
    Authorization: `Bearer ${signToken({ uid, role: 'passenger' })}`,
  });
  const application = {
    vehicleType: 'economy',
    brand: 'Toyota',
    model: 'Prius',
    color: 'White',
    number: 'AA1234BB',
    vehicleYear: 2020,
  };

  it('accepts a first application from an account with no driverInfo yet', async () => {
    await store().saveUser({
      uid: 'reg_fresh',
      role: 'passenger',
      name: 'reg_fresh',
      rating: 5,
      ratingCount: 0,
      isBlocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await request(app).post('/api/drivers/register').set(authFor('reg_fresh')).send(application);
    expect(res.status).toBe(201);
    expect(res.body.user.driverInfo.applicationStatus).toBe('pending');
  });

  it('lets a rejected applicant resubmit', async () => {
    await store().saveUser({
      uid: 'reg_rejected',
      role: 'passenger',
      name: 'reg_rejected',
      rating: 5,
      ratingCount: 0,
      isBlocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      driverInfo: baseInfo({ applicationStatus: 'rejected' }),
    });
    const res = await request(app).post('/api/drivers/register').set(authFor('reg_rejected')).send(application);
    expect(res.status).toBe(201);
    expect(res.body.user.driverInfo.applicationStatus).toBe('pending');
  });

  // The client only reaches this screen when driverInfo is absent — an
  // already-approved driver has no button that leads here. That's UI, not a
  // boundary the endpoint enforced: nothing on the server stopped a second
  // call from overwriting an approved driver's info and resetting
  // applicationStatus back to 'pending', demoting them with no warning, mid
  // possibly-active-ride.
  it('refuses to overwrite an already-approved driver', async () => {
    await store().saveUser({
      uid: 'reg_approved',
      role: 'driver',
      name: 'reg_approved',
      rating: 5,
      ratingCount: 0,
      isBlocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      driverInfo: baseInfo({ applicationStatus: 'approved', licenseVerified: true, number: 'ORIGINAL-PLATE' }),
    });
    const res = await request(app)
      .post('/api/drivers/register')
      .set(authFor('reg_approved'))
      .send({ ...application, number: 'HIJACKED-PLATE' });
    expect(res.status).toBe(409);

    const stored = await store().getUser('reg_approved');
    expect(stored?.driverInfo?.applicationStatus).toBe('approved');
    expect(stored?.driverInfo?.number).toBe('ORIGINAL-PLATE');
  });
});
