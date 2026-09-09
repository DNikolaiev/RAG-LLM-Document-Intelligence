import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { CASES_RUNTIME, type CasesRuntime } from './cases-runtime.js';
import { Context, type RequestContext } from './request-context.js';

/**
 * The publisher's half of consumer lag.
 *
 * A read model can report how far it has projected and nothing more - it has no access to the
 * outbox, deliberately. The gap between the two numbers is what "eventually consistent" means in
 * practice, and neither service can compute it alone.
 */
@Controller('v1/events')
export class EventsController {
  constructor(@Inject(CASES_RUNTIME) private readonly cases: CasesRuntime) {}

  @Get('state')
  async state(@Context() context: RequestContext) {
    // Demo mode has no outbox at all, so this is genuinely absent rather than zero - reporting a
    // mark of 0 would read as "nothing has happened yet" instead of "there is nothing to measure".
    if (!('outboxState' in this.cases)) {
      throw new NotFoundException({
        code: 'NOT_AVAILABLE',
        message: 'The event backbone is not composed in this runtime.',
      });
    }
    return (
      this.cases as { outboxState: (context: RequestContext) => Promise<unknown> }
    ).outboxState(context);
  }
}
