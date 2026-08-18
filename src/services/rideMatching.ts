import { listOnlineDriversCached } from './onlineDrivers';
import { haversineKm, isApprovedDriver } from '../utils/helpers';
import {
  DEFAULT_SEARCH_RADIUS_KM,
  EXTENDED_SEARCH_RADIUS_KM,
} from '../config/constants';
import type { GeoPoint, User, VehicleType } from '../types';

export interface NearbyDriver {
  driver: User;
  distanceKm: number;
}

// Find online drivers near a pickup point, nearest first. Optionally filters by
// vehicle type. Widens from the default to the extended radius if nothing is found.
export async function findNearbyDrivers(
  pickup: GeoPoint,
  vehicleType?: VehicleType,
  radiusKm: number = DEFAULT_SEARCH_RADIUS_KM
): Promise<NearbyDriver[]> {
  const online = await listOnlineDriversCached();

  const within = (radius: number): NearbyDriver[] =>
    online
      // Belt-and-braces: the online gates already require approval, but a
      // driver rejected *after* going online keeps isOnline=true in the store
      // until they reconnect. Never surface them as an available car.
      .filter((d) => isApprovedDriver(d.driverInfo))
      .filter((d) => d.driverInfo?.lastLocation)
      .filter((d) => !vehicleType || d.driverInfo?.vehicleType === vehicleType)
      .map((d) => {
        const loc = d.driverInfo!.lastLocation!;
        return {
          driver: d,
          distanceKm: haversineKm(pickup.lat, pickup.lng, loc.lat, loc.lng),
        };
      })
      .filter((x) => x.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);

  const near = within(radiusKm);
  if (near.length > 0) return near;
  // Widen the net once before giving up.
  return within(EXTENDED_SEARCH_RADIUS_KM);
}
