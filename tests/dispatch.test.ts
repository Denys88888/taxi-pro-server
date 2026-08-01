import { WebSocket } from 'ws';
import { registerSocket, unregisterSocket, broadcastToDriversOfType, type AuthedSocket } from '../src/websocket/broadcast';
import type { VehicleType } from '../src/types';

// Ride offers used to go to every connected driver socket whose profile had a
// vehicleType — which is set at connect time from the stored profile, not from
// the shift toggle. So a driver who was off shift but merely had the app open
// collected every offer in the city. Dispatch now requires ws.driverOnline.

interface FakeSocket extends Partial<AuthedSocket> {
  sent: string[];
}

function mkDriver(
  uid: string,
  vehicleType: VehicleType,
  driverOnline: boolean | undefined,
  location?: { lat: number; lng: number }
): FakeSocket {
  const sent: string[] = [];
  const ws: FakeSocket = {
    sent,
    userId: uid,
    role: 'driver',
    vehicleType,
    driverOnline,
    driverLocation: location,
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
  } as unknown as FakeSocket;
  return ws;
}

const KYIV = { lat: 50.4501, lng: 30.5234 };
// unregisterSocket only removes a socket it still holds by identity, so the
// cleanup has to hand back the very objects that were registered.
const registered: [string, AuthedSocket][] = [];

function reg(uid: string, ws: FakeSocket): void {
  const sock = ws as unknown as AuthedSocket;
  registerSocket(uid, sock);
  registered.push([uid, sock]);
}

afterEach(() => {
  for (const [uid, sock] of registered.splice(0)) unregisterSocket(uid, sock);
});

describe('broadcastToDriversOfType', () => {
  it('offers only to drivers marked on shift', () => {
    const onShift = mkDriver('d_on', 'economy', true, KYIV);
    const offShift = mkDriver('d_off', 'economy', false, KYIV);
    // Legacy/unknown state — a socket that never announced a shift must not be
    // treated as available.
    const unknown = mkDriver('d_unknown', 'economy', undefined, KYIV);
    reg('d_on', onShift);
    reg('d_off', offShift);
    reg('d_unknown', unknown);

    const offered = broadcastToDriversOfType({ type: 'ride_available' }, 'economy', KYIV, 10);

    expect(offered).toEqual(['d_on']);
    expect(onShift.sent).toHaveLength(1);
    expect(offShift.sent).toHaveLength(0);
    expect(unknown.sent).toHaveLength(0);
  });

  it('still respects the vehicle class rules for on-shift drivers', () => {
    const eco = mkDriver('d_eco', 'economy', true, KYIV);
    const comfort = mkDriver('d_comfort', 'comfort', true, KYIV);
    reg('d_eco', eco);
    reg('d_comfort', comfort);

    // A comfort car can serve an economy request…
    expect(broadcastToDriversOfType({}, 'economy', KYIV, 10).sort()).toEqual(['d_comfort', 'd_eco']);
    // …but an economy car may not serve a comfort request.
    expect(broadcastToDriversOfType({}, 'comfort', KYIV, 10)).toEqual(['d_comfort']);
  });

  it('still filters an on-shift driver out by distance', () => {
    const near = mkDriver('d_near', 'economy', true, KYIV);
    const far = mkDriver('d_far', 'economy', true, { lat: 49.84, lng: 24.03 }); // Lviv, ~470 km
    reg('d_near', near);
    reg('d_far', far);

    expect(broadcastToDriversOfType({}, 'economy', KYIV, 10)).toEqual(['d_near']);
  });
});
