import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { documentTools, libraryInstructions } from '../shared/mcp.js';

const option = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const socketPath = option('--socket');
const credentialFile = option('--credential-file');
if (!socketPath) throw new Error('A Garnet socket is required. Use garnet mcp.');
async function callTool(name: string, args: unknown) {
  const secret = credentialFile ? (await readFile(credentialFile, 'utf8')).trim() : process.env.ED_JOB_TOKEN;
  if (!secret) throw new Error('Garnet MCP is not connected. Run npx garnet-mcp setup.');
  return new Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }>((resolve, reject) => {
    const req = request({ socketPath, path: '/tool', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, timeout: 30000 }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk);
      res.on('error', reject);
      res.on('end', () => resolve({ content: [{ type: 'text', text: raw }], isError: (res.statusCode || 500) >= 400 }));
    });
    req.on('error', () => reject(new Error('Cannot reach Garnet. Start it with garnet start, then retry.')));
    req.on('timeout', () => req.destroy(new Error('Garnet timed out')));
    req.end(JSON.stringify({ name, arguments: args }));
  });
}
const server = new McpServer({ name: 'garnet-library', version: '0.1.0' }, { instructions: libraryInstructions });
for (const [name, tool] of Object.entries(documentTools)) {
  server.registerTool(name, { description: tool.description, inputSchema: tool.schema, annotations: { readOnlyHint: !['create_document', 'edit_document'].includes(name), destructiveHint: name === 'edit_document', openWorldHint: false } }, async (args: any) => {
    try { return await callTool(name, args); }
    catch (error) { return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true }; }
  });
}
await server.connect(new StdioServerTransport());
