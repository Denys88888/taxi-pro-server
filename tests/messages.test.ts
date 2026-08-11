import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';

const app = createApp();
const passengerAuth = { Authorization: `Bearer ${signToken({ uid: 'msg-passenger', role: 'passenger' })}` };
const outsiderAuth = { Authorization: `Bearer ${signToken({ uid: 'msg-outsider', role: 'passenger' })}` };

const validRide = {
  pickup: { lat: 52.23, lng: 21.01, address: 'A' },
  destination: { lat: 52.2, lng: 21.05, address: 'B' },
  vehicleType: 'economy' as const,
};

describe('messages API', () => {
  it('requires authentication to read or send', async () => {
    expect((await request(app).get('/api/messages?chatId=chat_x')).status).toBe(401);
    expect((await request(app).post('/api/messages').send({ chatId: 'chat_x', text: 'hi' })).status).toBe(401);
  });

  // Guards against exactly the bug fixed here: getHistory's participant check
  // used to run only `if (ride && ...)`, which a ride lookup miss (null)
  // short-circuited past entirely — an unauthenticated read of any chat whose
  // ride no longer resolves. Rides are never hard-deleted today so this path
  // isn't reachable through a real ride yet, but a chatId with no ride behind
  // it at all (nonsense id, or a future retention job) must still 403, not
  // silently return whatever getMessages(chatId) happens to hold.
  it('denies chat history for a chatId with no ride behind it', async () => {
    const res = await request(app).get('/api/messages?chatId=chat_does_not_exist').set(passengerAuth);
    expect(res.status).toBe(403);
  });

  it('lets both ride participants read and send, and blocks everyone else', async () => {
    const created = await request(app).post('/api/rides').set(passengerAuth).send(validRide);
    const rideId = created.body.id;
    const chatId = `chat_${rideId}`;

    const outsiderRead = await request(app).get(`/api/messages?chatId=${chatId}`).set(outsiderAuth);
    expect(outsiderRead.status).toBe(403);

    const outsiderSend = await request(app)
      .post('/api/messages')
      .set(outsiderAuth)
      .send({ chatId, text: 'not my ride' });
    expect(outsiderSend.status).toBe(403);

    const sent = await request(app)
      .post('/api/messages')
      .set(passengerAuth)
      .send({ chatId, text: 'hello driver' });
    expect(sent.status).toBe(201);
    expect(sent.body.senderId).toBe('msg-passenger');
    // senderId/senderRole must come from the token, never the request body.
    expect(sent.body.senderRole).toBe('passenger');

    const history = await request(app).get(`/api/messages?chatId=${chatId}`).set(passengerAuth);
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(1);
    expect(history.body.messages[0].text).toBe('hello driver');
  });

  it('rejects an empty message (400), not a silent no-op', async () => {
    // Own uid: messageLimiter runs before validate() in the route chain, so a
    // shared identity here would risk 429 masking the 400 this test is for.
    const auth = { Authorization: `Bearer ${signToken({ uid: 'msg-empty', role: 'passenger' })}` };
    const created = await request(app).post('/api/rides').set(auth).send(validRide);
    const chatId = `chat_${created.body.id}`;

    const empty = await request(app).post('/api/messages').set(auth).send({ chatId, text: '' });
    expect(empty.status).toBe(400);
  });

  it('rejects an over-length message (400)', async () => {
    const auth = { Authorization: `Bearer ${signToken({ uid: 'msg-toolong', role: 'passenger' })}` };
    const created = await request(app).post('/api/rides').set(auth).send(validRide);
    const chatId = `chat_${created.body.id}`;

    const tooLong = await request(app)
      .post('/api/messages')
      .set(auth)
      .send({ chatId, text: 'x'.repeat(10000) });
    expect(tooLong.status).toBe(400);
  });
});
