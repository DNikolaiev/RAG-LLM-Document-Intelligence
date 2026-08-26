import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { CaseLensApiClient } from './api-client.js';
import { createServer } from './server.js';

const client = new CaseLensApiClient({
  baseUrl: process.env.CASELENS_API_URL ?? 'http://localhost:4100',
  tenantId: process.env.CASELENS_TENANT_ID ?? 'tenant_demo',
});
const server = createServer(client);
await server.connect(new StdioServerTransport());
