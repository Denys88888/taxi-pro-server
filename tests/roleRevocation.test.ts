import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import { forgetBlockCheck } from '../src/middleware/auth';
import { nowIso } from '../src/utils/helpers';
import type { User } from '../src/types';

// A JWT is good for 24 hours and carries the role it was minted with. Taking
// admin away from someone wrote the new role to the store but left every HTTP
// admin route reading the token's stale claim, so a demoted admin kept full
// access until their token happened to expire. Blocking them worked; demoting
// them did not. The socket path already preferred the stored role — this is the
// same rule for HTTP.
const app = createApp();

async function seed(uid: string, role: User['role']): Promise<void> {
  await store().saveUser({
    uid,
    role,
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  forgetBlockCheck(uid);
}

describe('a token that still claims a role the account no longer has', () => {
  it('stops opening admin routes once the account is demoted', async () => {
    const uid = 'demoted_admin';
    const adminToken = signToken({ uid, role: 'admin' });
    await seed(uid, 'admin');

    // Sanity: the token works while the account really is an admin.
    expect(
      (await request(app).get('/api/admin/stats').set({ Authorization: `Bearer ${adminToken}` }))
        .status
    ).toBe(200);

    // Demote in the store. The token is untouched and still says "admin".
    await store().updateUser(uid, { role: 'passenger' });
    forgetBlockCheck(uid);

    const after = await request(app)
      .get('/api/admin/stats')
      .set({ Authorization: `Bearer ${adminToken}` });

    expect(after.status).toBe(403);
  });

  // The store wins in the other direction too, deliberately — that is what lets
  // a driver approved after logging in start working without a re-login. It is
  // safe only because nothing but ADMIN_UIDS or an existing admin can write
  // role='admin' in the first place; if that ever stops being true, this test
  // is the one that should force the debate.
  it('lets a stored promotion take effect on an older token', async () => {
    const uid = 'promoted_later';
    const passengerToken = signToken({ uid, role: 'passenger' });
    await seed(uid, 'passenger');

    await store().updateUser(uid, { role: 'admin' });
    forgetBlockCheck(uid);

    const res = await request(app)
      .get('/api/admin/stats')
      .set({ Authorization: `Bearer ${passengerToken}` });

    expect(res.status).toBe(200);
  });
});
