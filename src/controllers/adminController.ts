import type { Request, Response } from 'express';
import { store } from '../models';
import { round } from '../utils/helpers';
import { sendToUser } from '../websocket/broadcast';
import type { Settings, Role, RideStatus } from '../types';

const ROLES: Role[] = ['passenger', 'driver', 'admin'];
const RIDE_STATUSES: RideStatus[] = [
  'searching',
  'assigned',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
];

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

// PATCH /api/admin/users/:id — block or unblock a user.
export async function updateUserBlock(req: Request, res: Response): Promise<void> {
  const { isBlocked, blockReason } = req.body as {
    isBlocked: boolean;
    blockReason?: string;
  };
  const updated = await store().updateUser(req.params.id, {
    isBlocked,
    blockReason: isBlocked ? blockReason : undefined,
  });
  if (!updated) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (isBlocked) sendToUser(req.params.id, { type: 'error', message: 'Account blocked', code: 'BLOCKED' });
  res.json(updated);
}

// GET /api/admin/rides?status= — all rides.
export async function listAllRides(req: Request, res: Response): Promise<void> {
  const statusParam = String(req.query.status ?? '');
  const status = RIDE_STATUSES.includes(statusParam as RideStatus)
    ? (statusParam as RideStatus)
    : undefined;
  const rides = await store().listAllRides(status);
  res.json({ rides });
}

// GET /api/admin/reports?status= — complaint queue.
export async function listReports(req: Request, res: Response): Promise<void> {
  const status = req.query.status as 'open' | 'resolved' | 'dismissed' | undefined;
  const reports = await store().listReports(status);
  res.json({ reports });
}

// PATCH /api/admin/reports/:id — resolve or dismiss a report.
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
        driverInfo: { ...user.driverInfo, licenseVerified: true },
      })
    : await store().updateUser(req.params.id, {
        driverInfo: { ...user.driverInfo, licenseVerified: false, isOnline: false },
      });
  sendToUser(req.params.id, {
    type: 'ride_status_update',
    rideId: '',
    status: approve ? 'driver_approved' : 'driver_rejected',
    data: {},
  });
  res.json({ approved: approve, user: updated });
}
