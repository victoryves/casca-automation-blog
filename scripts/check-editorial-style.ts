#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import { lintEditorialCopy } from '../src/modules/synthesis/editorial-lint.js';
const files=process.argv.slice(2);
if(!files.length){console.error('Usage: npx tsx scripts/check-editorial-style.ts article.txt [article.md]');process.exitCode=2;}
for(const file of files){
  try{
    const result=await lintEditorialCopy(await fs.readFile(file,'utf8'));
    console.log(JSON.stringify({file,...result},null,2));
    if(result.findings.some(f=>f.severity==='error'))process.exitCode=1;
  }catch(error){console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);process.exitCode=1;}
}
