import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import type { RequestContext } from './request-context.js';

const roles = new Set(['intake', 'reviewer', 'approver', 'auditor', 'admin']);

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const roleHeader = request.header('x-role') ?? 'reviewer';
    const correlationId = request.header('x-correlation-id') ?? `cor_${ulid()}`;
    (request as Request & { context: RequestContext }).context = {
      tenantId: request.header('x-tenant-id') ?? 'tenant_demo',
      userId: request.header('x-user-id') ?? 'user_demo_reviewer',
      role: roles.has(roleHeader)
        ? (roleHeader as 'intake' | 'reviewer' | 'approver' | 'auditor' | 'admin')
        : 'reviewer',
      correlationId,
    };
    response.setHeader('x-correlation-id', correlationId);
    next();
  }
}
