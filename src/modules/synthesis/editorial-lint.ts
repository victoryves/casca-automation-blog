import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { editorialFindings, type EditorialFinding } from '../../utils/editorial-style.js';

export async function lintEditorialCopy(content: string): Promise<{engine:'vale'|'builtin'; findings:EditorialFinding[]}> {
  const findings=editorialFindings(content);
  const executable=process.env.CASCA_VALE_PATH || path.resolve('vendor/vale/vale');
  try { await fs.access(executable); }
  catch {
    if (process.env.CASCA_VALE_PATH) throw new Error('editorial-vale:configured-binary-missing');
    return {engine:'builtin',findings};
  }
  const output=await new Promise<string>((resolve,reject)=>{
    const child=spawn(executable,['--no-global','--no-exit','--output=JSON',`--config=${path.resolve('.vale.ini')}`,'--ext=.txt'],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('editorial-vale:timeout'));},10000);
    child.stdout.on('data',chunk=>{stdout+=String(chunk);});
    child.stderr.on('data',chunk=>{stderr+=String(chunk);});
    child.stdin.on('error',()=>{});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(`editorial-vale:exit-${code}:${stderr.slice(0,200)}`));});
    child.stdin.end(content);
  });
  const payload=JSON.parse(output) as Record<string,Array<{Check:string;Severity:string;Message:string}>>;
  for(const alerts of Object.values(payload)) for(const alert of alerts) {
    const rule=alert.Check.replace(/^CASCA\./,'');
    if (!findings.some(f=>f.rule===rule)) findings.push({rule,severity:alert.Severity==='error'?'error':'warning',message:alert.Message});
  }
  return {engine:'vale',findings};
}
