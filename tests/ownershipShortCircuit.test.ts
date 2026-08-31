import request from 'supertest';

// The bug this pins is a shape, not a typo: `if (data.user_uid && data.user_uid !== uid)`.
// A missing owner field made the whole condition false, so the ownership check
// was skipped rather than failed — and piFetch substitutes an empty object
// whenever a 200 response body will not parse as JSON, which is exactly how a
// reply with no owner in it reaches this code. Absent ownership must never read
// as proof of ownership. The same shape has bitten this repo before (see the
// `if (ride && ride.passengerId !== uid)` note in CLAUDE.md).
const getPiPayment = jest.fn();
jest.mock('../src/services/piService', () => ({
  getPiPayment: (...args: unknown[]) => getPiPayment(...args),
  cancelPayment: jest.fn().mockResolvedValue({ ok: true, status: 'cancelled' }),
  approvePayment: jest.fn(),
  completePayment: jest.fn(),
  payoutToDriver: jest.fn(),
}));

import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';

const app = createApp();
const auth = { Authorization: `Bearer ${signToken({ uid: 'attacker', role: 'passenger' })}` };

describe('cancelling a Pi payment that is not yours', () => {
  it('refuses when Pi names a different owner', async () => {
    getPiPayment.mockResolvedValue({ ok: true, status: 200, data: { user_uid: 'the_victim' } });

    const res = await request(app)
      .post('/api/payments/cancel-unknown-pi')
      .set(auth)
      .send({ piPaymentId: 'pi_abc123' });

    expect(res.status).toBe(403);
  });

  // The regression itself: a 200 whose body did not parse leaves data as {}.
  it('refuses when Pi returns no owner at all, instead of cancelling anyway', async () => {
    getPiPayment.mockResolvedValue({ ok: true, status: 200, data: {} });

    const res = await request(app)
      .post('/api/payments/cancel-unknown-pi')
      .set(auth)
      .send({ piPaymentId: 'pi_unparseable' });

    expect(res.status).toBe(403);
  });

  it('still lets the real owner cancel their own payment', async () => {
    getPiPayment.mockResolvedValue({ ok: true, status: 200, data: { user_uid: 'attacker' } });

    const res = await request(app)
      .post('/api/payments/cancel-unknown-pi')
      .set(auth)
      .send({ piPaymentId: 'pi_mine' });

    expect(res.status).toBe(200);
  });
});
