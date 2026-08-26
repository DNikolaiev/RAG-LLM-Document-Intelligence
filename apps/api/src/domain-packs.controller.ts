import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { DomainPackSchema, parseDomainPack } from '@caselens/domain';
import { parseBody } from './validation.js';

@Controller('v1/domain-packs')
export class DomainPacksController {
  @Get()
  list() {
    return {
      items: [
        {
          id: 'pack_pharmacy_supplier_1_0_0',
          key: 'pharmacy-supplier',
          name: 'Pharmacy supplier qualification',
          version: '1.0.0',
          status: 'active',
          terminology: {
            case: 'Supplier dossier',
            subject: 'Supplier',
            decision: 'Qualification decision',
          },
        },
      ],
    };
  }

  @Post('validate')
  validate(@Body() body: unknown) {
    const parsed = parseBody(DomainPackSchema, body);
    const pack = (() => {
      try {
        return parseDomainPack(parsed);
      } catch (error) {
        throw new BadRequestException({
          code: 'INVALID_DOMAIN_PACK',
          message: error instanceof Error ? error.message : 'Domain pack validation failed.',
        });
      }
    })();
    return {
      valid: true,
      key: pack.id,
      version: pack.version,
      ruleCount: pack.rules.length,
      warnings: [],
    };
  }
}
