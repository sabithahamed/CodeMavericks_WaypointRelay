import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export type Role = 'dispatcher' | 'loader' | 'driver' | 'store';
export interface AuthUser {
  id: number;
  email: string;
  role: Role;
  name: string;
  depot: string | null;
  outlet_id: string | null;
  vehicle_id: string | null;
}

const SECRET = process.env.JWT_SECRET ?? 'dev-only-secret-change-me';

export const signToken = (u: AuthUser) => jwt.sign(u, SECRET, { expiresIn: '7d' });

declare module 'express-serve-static-core' {
  interface Request {
    user: AuthUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  try {
    req.user = jwt.verify(token, SECRET) as AuthUser;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: `This action is for the ${roles.join(' or ')} role.` });

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
