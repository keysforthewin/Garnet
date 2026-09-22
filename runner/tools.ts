import { createInterface } from 'node:readline';
import { request } from 'node:http';
const at = process.argv.indexOf('--socket');
const socketPath = process.argv[at + 1];
const properties = { id: { type: 'string', description: 'Document ID returned by the library' }, version: { type: 'string', description: 'Version returned by read_document; required for edits' }, markdown: { type: 'string' }, find: { type: 'string', description: 'Exact text that occurs once in the current Markdown' }, replace: { type: 'string' } };
const tools = [
  { name: 'list_documents', description: 'List shared library documents', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_documents', description: 'Search titles and document contents', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_document', description: 'Read current live Markdown and its version before editing', inputSchema: { type: 'object', properties: { id: properties.id }, required: ['id'] } },
  { name: 'create_document', description: 'Create a new document in the shared library', inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: properties.markdown }, required: ['title'] } },
  { name: 'edit_document', description: 'Apply an edit to the live collaborative document. Supply either find and replace, or complete markdown. On version conflict read and retry.', inputSchema: { type: 'object', properties, required: ['id', 'version'] } },
];
function callTool(params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/tool', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ED_JOB_TOKEN}` }, timeout: 30000 }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => resolve({ content: [{ type: 'text', text: raw }], isError: res.statusCode! >= 400 }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Document service timed out'))); req.end(JSON.stringify(params));
  });
}
createInterface({ input: process.stdin }).on('line', async line => {
  let message: any; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  try {
    let result: any;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'garnet-library', version: '0.1.0' } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') result = await callTool(message.params);
    else if (message.method === 'ping') result = {};
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch (error: any) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }) + '\n'); }
});
