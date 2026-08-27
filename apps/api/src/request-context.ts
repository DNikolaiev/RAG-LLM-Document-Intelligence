import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestContext {
  profileId: string;
  tenantId: string;
  tenantIds: readonly string[];
  userId: string;
  role: 'intake' | 'reviewer' | 'approver' | 'auditor' | 'admin';
  platformAdmin: boolean;
  correlationId: string;
}

export const Context = createParamDecorator(
  (_data: unknown, execution: ExecutionContext): RequestContext => {
    const request = execution.switchToHttp().getRequest<Request>();
    return (request as Request & { context: RequestContext }).context;
  },
);
