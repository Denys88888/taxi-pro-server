import type { Request, Response } from 'express';
import { store } from '../models';
import { genId, nowIso } from '../utils/helpers';
import { logger } from '../utils/logger';
import type { Report } from '../types';

// POST /api/reports — a passenger or driver files a complaint about a ride/user.
// The report lands in the admin queue (GET /api/admin/reports) for resolution.
export async function createReport(req: Request, res: Response): Promise<void> {
  const { rideId, reportedId, reason, description } = req.body as {
    rideId: string;
    reportedId: string;
    reason: string;
    description?: string;
  };
  // The reporter must be a participant of the ride they're reporting.
  const ride = await store().getRide(rideId);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  const uid = req.user!.uid;
  if (ride.passengerId !== uid && ride.driverId !== uid) {
    res.status(403).json({ error: 'Not a participant of this ride' });
    return;
  }
  const report: Report = {
    id: genId('report'),
    rideId,
    reporterId: uid,
    reportedId,
    reason,
    description,
    status: 'open',
    createdAt: nowIso(),
  };
  await store().addReport(report);
  logger.info('[Report] filed', { rideId, reporterId: uid, reportedId });
  res.status(201).json(report);
}
