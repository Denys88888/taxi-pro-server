import type { Request, Response } from 'express';
import { store } from '../models';
import { round } from '../utils/helpers';
import { sendToUser, closeUserSocket } from '../websocket/broadcast';
import { payoutDriver } from './paymentController';
import { cancelPayment as piCancelPayment } from '../services/piService';
import type { Settings, Role, RideStatus } from '../types';

const ROLES: Role[] = ['passenger', 'driver', 'admin'];
const RIDE_STATUSES: RideStatus[] = [
  'scheduled',
  'searching',
  'assigned',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
];

// POST /api/admin/rides/:id/retry-payout — manually re-run the driver A2U
// payout for a ride whose driverPayoutStatus is 'failed' (or absent), and
// return the outcome (including the error message) directly in the response
// so it's diagnosable without pulling server logs.
export async function retryRidePayout(req: Request, res: Response): Promise<void> {
  const ride = await store().getRide(req.params.id);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  if (!ride.driverId || ride.paymentStatus !== 'completed') {
    res.status(409).json({ error: 'Ride has no completed fare payment to pay out' });
    return;
  }
  await payoutDriver(ride, 'fare', ride.driverEarnings);
  const updated = await store().getRide(req.params.id);
  res.json({
    driverPayoutStatus: updated?.driverPayoutStatus,
    driverPayoutTxid: updated?.driverPayoutTxid,
    driverPayoutError: updated?.driverPayoutError,
  });
}

// POST /api/admin/pi-payments/:identifier/cancel — cancel a Pi payment stuck
// in 'approved' (never completed) that's blocking new A2U payouts to the
// same user (Pi rejects a second A2U payment with "ongoing_payment_found"
// until the first is resolved). Manual escape hatch — this is not something
// the normal payout flow ever needs on the happy path.
export async function cancelPiPayment(req: Request, res: Response): Promise<void> {
  const result = await piCancelPayment(req.params.identifier);
  res.status(result.ok ? 200 : 502).json({ success: result.ok, status: result.status, data: result.data });
}

// GET /api/admin/stats — dashboard summary cards.
export async function getStats(_req: Request, res: Response): Promise<void> {
  const [rides, users, reports] = await Promise.all([
    store().listAllRides(),
    store().listUsers(),
    store().listReports('open'),
  ]);
  const completed = rides.filter((r) => r.status === 'completed');
  const platformEarnings = round(
    completed.reduce((sum, r) => sum + (r.platformFee || 0), 0)
  );
  res.json({
    totalRides: rides.length,
    completedRides: completed.length,
    activeUsers: users.filter((u) => !u.isBlocked).length,
    totalUsers: users.length,
    drivers: users.filter((u) => u.role === 'driver').length,
    platformEarnings,
    pendingReports: reports.length,
  });
}

// GET /api/admin/users?role=&search= — user directory.
export async function listUsers(req: Request, res: Response): Promise<void> {
  const roleParam = String(req.query.role ?? '');
  const role = ROLES.includes(roleParam as Role) ? (roleParam as Role) : undefined;
  const users = await store().listUsers(role);
  const search = String(req.query.search ?? '').toLowerCase().trim();
  const filtered = search
    ? users.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.uid.toLowerCase().includes(search)
      )
    : users;
  res.json({ users: filtered });
}

// PATCH /api/admin/users/:id — block/unblock a user or change their role.
export async function updateUserBlock(req: Request, res: Response): Promise<void> {
  const { isBlocked, blockReason, role, driverInfo } = req.body as {
    isBlocked?: boolean;
    blockReason?: string;
    role?: string;
    driverInfo?: Record<string, unknown>;
  };
  const patch: Record<string, unknown> = {};
  if (role !== undefined) patch.role = role;
  if (driverInfo !== undefined) patch.driverInfo = driverInfo;
  if (isBlocked !== undefined) {
    patch.isBlocked = isBlocked;
    patch.blockReason = isBlocked ? blockReason : undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await store().updateUser(req.params.id, patch as any);
  if (!updated) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (isBlocked) {
    // Deliver the block notice, then sever the live socket so the banned user
    // can't keep acting over their existing connection.
    closeUserSocket(req.params.id, { type: 'error', message: 'Account blocked', code: 'BLOCKED' });
    // Cancel any active rides for the blocked user.
    const activeStatuses: RideStatus[] = ['assigned', 'arrived', 'in_progress', 'searching'];
    for (const status of activeStatuses) {
      const rides = await store().listAllRides(status);
      for (const ride of rides) {
        if (ride.passengerId === req.params.id || ride.driverId === req.params.id) {
          await store().updateRide(ride.id, { status: 'cancelled' });
          const other = ride.passengerId === req.params.id ? ride.driverId : ride.passengerId;
          if (other) sendToUser(other, { type: 'ride_status_update', rideId: ride.id, status: 'cancelled', data: {} });
        }
      }
    }
  }
  res.json(updated);
}

// GET /api/admin/rides?status= — all rides, with party names for the table view.
export async function listAllRides(req: Request, res: Response): Promise<void> {
  const statusParam = String(req.query.status ?? '');
  const status = RIDE_STATUSES.includes(statusParam as RideStatus)
    ? (statusParam as RideStatus)
    : undefined;
  const [rides, users] = await Promise.all([store().listAllRides(status), store().listUsers()]);
  const names = new Map(users.map((u) => [u.uid, u.name]));
  res.json({
    rides: rides.map((r) => ({
      ...r,
      passengerName: names.get(r.passengerId) ?? r.passengerId,
      driverName: r.driverId ? names.get(r.driverId) ?? r.driverId : undefined,
    })),
  });
}

// GET /api/admin/drivers?status=pending|approved|rejected — every driver
// application with its review status (legacy records infer from licenseVerified).
export async function listDrivers(req: Request, res: Response): Promise<void> {
  const filter = String(req.query.status ?? '');
  const users = await store().listUsers();
  const drivers = users
    .filter((u) => u.driverInfo)
    .map((u) => ({
      ...u,
      applicationStatus:
        u.driverInfo!.applicationStatus ??
        (u.driverInfo!.licenseVerified ? 'approved' : 'pending'),
    }));
  res.json({
    drivers: filter ? drivers.filter((d) => d.applicationStatus === filter) : drivers,
  });
}

// GET /api/admin/analytics — charts for the admin dashboard: rides per hour of
// day (last 7 days), revenue per day (last 14 days), top drivers and routes.
export async function getAnalytics(_req: Request, res: Response): Promise<void> {
  const [rides, users] = await Promise.all([store().listAllRides(), store().listUsers()]);
  const names = new Map(users.map((u) => [u.uid, u.name]));
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const ridesByHour = new Array(24).fill(0) as number[];
  for (const r of rides) {
    const t = new Date(r.createdAt);
    if (now - t.getTime() <= 7 * DAY) ridesByHour[t.getUTCHours()] += 1;
  }

  const revenueByDay: { date: string; revenue: number; rides: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now - i * DAY).toISOString().slice(0, 10);
    revenueByDay.push({ date, revenue: 0, rides: 0 });
  }
  const byDate = new Map(revenueByDay.map((d) => [d.date, d]));
  for (const r of rides) {
    if (r.status !== 'completed') continue;
    const day = byDate.get(r.createdAt.slice(0, 10));
    if (day) {
      day.revenue = round(day.revenue + (r.platformFee || 0));
      day.rides += 1;
    }
  }

  const driverAgg = new Map<string, { rides: number; earnings: number }>();
  const routeAgg = new Map<string, number>();
  for (const r of rides) {
    if (r.status !== 'completed') continue;
    if (r.driverId) {
      const agg = driverAgg.get(r.driverId) ?? { rides: 0, earnings: 0 };
      agg.rides += 1;
      agg.earnings = round(agg.earnings + (r.driverEarnings || 0) + (r.tipAmount || 0));
      driverAgg.set(r.driverId, agg);
    }
    const short = (a?: string) => (a ?? '?').split(',')[0].trim();
    const route = `${short(r.pickup.address)} → ${short(r.destination.address)}`;
    routeAgg.set(route, (routeAgg.get(route) ?? 0) + 1);
  }
  const topDrivers = [...driverAgg.entries()]
    .map(([uid, agg]) => ({ uid, name: names.get(uid) ?? uid, ...agg }))
    .sort((a, b) => b.earnings - a.earnings)
    .slice(0, 5);
  const topRoutes = [...routeAgg.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.json({ ridesByHour, revenueByDay, topDrivers, topRoutes });
}

// GET /api/admin/reports?status= — complaint queue.
export async function listReports(req: Request, res: Response): Promise<void> {
  const status = req.query.status as 'open' | 'resolved' | 'dismissed' | undefined;
  const reports = await store().listReports(status);
  res.json({ reports });
}

// PATCH /api/admin/reports/:id — resolve or dismiss a report. Resolving one
// (i.e. the complaint was legitimate) counts toward that user's auto-block
// threshold — dismissed reports never count, since they were invalid.
export async function resolveReport(req: Request, res: Response): Promise<void> {
  const { status } = req.body as { status: 'resolved' | 'dismissed' };
  const updated = await store().updateReport(req.params.id, {
    status,
    resolvedBy: req.user!.uid,
  });
  if (!updated) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  if (status === 'resolved') {
    const settings = await store().getSettings();
    const resolved = await store().listReports('resolved');
    const strikeCount = resolved.filter((r) => r.reportedId === updated.reportedId).length;
    if (strikeCount >= settings.autoBlockThreshold) {
      const target = await store().getUser(updated.reportedId);
      if (target && !target.isBlocked) {
        await store().updateUser(updated.reportedId, {
          isBlocked: true,
          blockReason: `Auto-blocked: ${strikeCount} resolved reports`,
        });
        closeUserSocket(updated.reportedId, { type: 'error', message: 'Account blocked', code: 'BLOCKED' });
      }
    }
  }
  res.json(updated);
}

// GET /api/admin/settings — current global settings.
export async function getSettings(_req: Request, res: Response): Promise<void> {
  res.json(await store().getSettings());
}

// PATCH /api/admin/settings — update settings (fee constrained 0–20% by schema).
export async function updateSettings(req: Request, res: Response): Promise<void> {
  const patch = req.body as Partial<Settings>;
  const updated = await store().updateSettings(patch, req.user!.uid);
  res.json(updated);
}

// GET /api/admin/drivers/pending — drivers awaiting verification.
export async function pendingDrivers(_req: Request, res: Response): Promise<void> {
  const users = await store().listUsers();
  const pending = users.filter((u) => u.driverInfo && !u.driverInfo.licenseVerified);
  res.json({ drivers: pending });
}

// POST /api/admin/drivers/:id/verify — approve or reject a driver application.
export async function verifyDriver(req: Request, res: Response): Promise<void> {
  const { approve } = req.body as { approve: boolean };
  const user = await store().getUser(req.params.id);
  if (!user?.driverInfo) {
    res.status(404).json({ error: 'No pending driver application' });
    return;
  }
  const updated = approve
    ? await store().updateUser(req.params.id, {
        role: 'driver',
        driverInfo: { ...user.driverInfo, licenseVerified: true, applicationStatus: 'approved' },
      })
    : await store().updateUser(req.params.id, {
        driverInfo: {
          ...user.driverInfo,
          licenseVerified: false,
          isOnline: false,
          applicationStatus: 'rejected',
        },
      });
  const wsPayload: Record<string, unknown> = {
    type: 'ride_status_update',
    rideId: '',
    status: approve ? 'driver_approved' : 'driver_rejected',
    data: {},
  };
  if (approve && updated) {
    const { signToken } = await import('../utils/jwt');
    wsPayload.token = signToken({ uid: req.params.id, role: 'driver', username: updated.name });
    wsPayload.user = updated;
  }
  sendToUser(req.params.id, wsPayload);
  res.json({ approved: approve, user: updated });
}
