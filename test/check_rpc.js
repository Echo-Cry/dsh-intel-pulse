import fs from 'node:fs';

const clientCode = fs.readFileSync('client.js', 'utf8');
const rpcCode = fs.readFileSync('lib/rpc.js', 'utf8');

const clientEndpoints = new Set([...clientCode.matchAll(/rpc\(['"]([a-zA-Z0-9_.]+)['"]/g)].map(m => m[1]));
const rpcEndpoints = new Set([...rpcCode.matchAll(/case ['"]([a-zA-Z0-9_.]+)['"]:/g)].map(m => m[1]));

console.log('Client RPC calls:', [...clientEndpoints].sort());
console.log('Server RPC handlers:', [...rpcEndpoints].sort());

const missingOnServer = [...clientEndpoints].filter(e => !rpcEndpoints.has(e));
console.log('Missing on Server:', missingOnServer);
