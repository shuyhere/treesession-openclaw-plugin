#!/usr/bin/env node
import fs from 'fs';
import { renderMermaidTree } from '../lib/tree.js';

function usage() {
  console.error('Usage: node scripts/render-mermaid.js <state-json-file>');
  process.exit(1);
}

const file = process.argv[2];
if (!file) usage();
if (!fs.existsSync(file)) {
  console.error(`State file not found: ${file}`);
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const mermaid = renderMermaidTree(state, { includeAssistantTurns: true });

console.log('```mermaid');
console.log(mermaid);
console.log('```');
