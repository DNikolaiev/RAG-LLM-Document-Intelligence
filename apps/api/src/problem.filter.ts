import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status =
      error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = error instanceof HttpException ? error.getResponse() : undefined;
    const details = typeof raw === 'object' && raw !== null ? raw : {};
    const safeTitle =
      status >= 500
        ? 'Internal server error'
        : error instanceof Error
          ? error.message
          : 'Request failed';

    response
      .status(status)
      .type('application/problem+json')
      .json({
        type: `https://caselens.dev/problems/${status}`,
        title: safeTitle,
        status,
        code:
          'code' in details && typeof details.code === 'string' ? details.code : `HTTP_${status}`,
        detail:
          'message' in details && typeof details.message === 'string' ? details.message : safeTitle,
        instance: request.originalUrl,
        correlationId:
          (request as Request & { context?: { correlationId: string } }).context?.correlationId ??
          'unknown',
        ...('issues' in details ? { issues: details.issues } : {}),
      });
  }
}
