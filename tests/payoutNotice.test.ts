// A driver used to be told "you earned X" the moment the passenger paid — before
// any payout was attempted — and then nothing, even when the payout failed. These
// pin the replacement: the driver hears about their money when it actually moves,
// and only then.

const sendToUser = jest.fn((..._args: unknown[]) => true);
jest.mock('../src/websocket/broadcast', () => ({
  ...jest.requireActual('../src/websocket/broadcast'),
  sendToUser: (...args: unknown[]) => sendToUser(...args),
}));

const payoutToUser = jest.fn();
jest.mock('../src/services/piService', () => ({
  ...jest.requireActual('../src/services/piService'),
  payoutToUser: (...args: unknown[]) => payoutToUser(...args),
}));

// A wallet seed, so payouts are actually attempted. The object is shared with
// the controller, which reads the seed at call time — so a test can take it away.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, env: { ...actual.env, PI_WALLET_SEED: 'S_TEST_SEED_NOT_REAL' } };
});

import { payoutDriver } from '../src/controllers/paymentController';
import { store } from '../src/models';
import { env } from '../src/config/env';
import { genId, nowIso } from '../src/utils/helpers';
import type { Ride } from '../src/types';

const DRIVER = 'drv_payout_notice';

async function seedRide(over: Partial<Ride> = {}): Promise<Ride> {
  const ride = {
    id: genId('ride'),
    passengerId: 'pax_payout_notice',
    driverId: DRIVER,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 10,
    platformFeePercent: 10,
    platformFee: 1,
    driverEarnings: 9,
    status: 'completed',
    paymentStatus: 'completed',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

const noticesToDriver = () =>
  sendToUser.mock.calls.filter(([uid]) => uid === DRIVER).map(([, msg]) => msg);

beforeEach(() => {
  sendToUser.mockClear();
  payoutToUser.mockReset();
});

describe('telling the driver what happened to their money', () => {
  it('says sent once the payout lands', async () => {
    payoutToUser.mockResolvedValue({ txid: 'tx_ok' });
    const ride = await seedRide();

    await payoutDriver(ride, 'fare', 9);

    expect(noticesToDriver()).toEqual([
      expect.objectContaining({ status: 'payout_sent', rideId: ride.id, data: { amount: 9, kind: 'fare' } }),
    ]);
  });

  // The case behind the report: Pi refused A2U, the driver was never paid, and
  // until now they were never told.
  it('says delayed when the payout fails', async () => {
    payoutToUser.mockRejectedValue(new Error('Pi A2U payment create failed (400): feature_not_available'));
    const ride = await seedRide();

    await payoutDriver(ride, 'fare', 9);

    expect(noticesToDriver()).toEqual([
      expect.objectContaining({ status: 'payout_delayed', data: { amount: 9, kind: 'fare' } }),
    ]);
    expect((await store().getRide(ride.id))?.driverPayoutStatus).toBe('failed');
  });

  // Funds settled on chain and only Pi's bookkeeping failed: the driver has it.
  it('says sent when the transfer settled but Pi could not confirm it', async () => {
    payoutToUser.mockRejectedValue(Object.assign(new Error('complete failed'), { txid: 'tx_settled' }));
    const ride = await seedRide();

    await payoutDriver(ride, 'fare', 9);

    expect(noticesToDriver()).toEqual([expect.objectContaining({ status: 'payout_sent' })]);
    expect((await store().getRide(ride.id))?.driverPayoutStatus).toBe('sent_unconfirmed');
  });

  it('says delayed when the app wallet cannot send at all', async () => {
    const seed = env.PI_WALLET_SEED;
    (env as { PI_WALLET_SEED?: string }).PI_WALLET_SEED = undefined;
    try {
      const ride = await seedRide();

      await payoutDriver(ride, 'tip', 2);

      expect(payoutToUser).not.toHaveBeenCalled();
      expect(noticesToDriver()).toEqual([
        expect.objectContaining({ status: 'payout_delayed', data: { amount: 2, kind: 'tip' } }),
      ]);
    } finally {
      (env as { PI_WALLET_SEED?: string }).PI_WALLET_SEED = seed;
    }
  });

  // Another attempt already owns this payout and will report its own outcome.
  // A second message here would tell the driver something twice, or wrongly.
  it('stays quiet on a duplicate attempt', async () => {
    const ride = await seedRide({ driverPayoutStatus: 'pending' });

    await payoutDriver(ride, 'fare', 9);

    expect(payoutToUser).not.toHaveBeenCalled();
    expect(noticesToDriver()).toEqual([]);
  });

  it('stays quiet when the money already moved', async () => {
    const ride = await seedRide({ driverPayoutStatus: 'completed', driverPayoutTxid: 'tx_done' });

    await payoutDriver(ride, 'fare', 9);

    expect(payoutToUser).not.toHaveBeenCalled();
    expect(noticesToDriver()).toEqual([]);
  });
});
