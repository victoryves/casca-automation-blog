/**
 * Logger Utility
 *
 * Simple logging utility with file output.
 */

import fs from 'fs';
import path from 'path';
import { format } from 'date-fns';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private logDir: string;
  private logLevel: LogLevel;

  constructor(logDir = './logs', logLevel: LogLevel = 'info') {
    this.logDir = logDir;
    this.logLevel = logLevel;
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    const dirs = [this.logDir, path.join(this.logDir, 'daily'), path.join(this.logDir, 'errors')];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(this.logLevel);
    const messageIndex = levels.indexOf(level);
    return messageIndex >= currentIndex;
  }

  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const metaStr = meta ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  private writeToFile(filename: string, content: string): void {
    const filepath = path.join(this.logDir, filename);
    fs.appendFileSync(filepath, content + '\n', 'utf-8');
  }

  debug(message: string, meta?: unknown): void {
    if (!this.shouldLog('debug')) return;
    const formatted = this.formatMessage('debug', message, meta);
    console.log(formatted);
    this.writeToFile(`daily/${format(new Date(), 'yyyy-MM-dd')}.log`, formatted);
  }

  info(message: string, meta?: unknown): void {
    if (!this.shouldLog('info')) return;
    const formatted = this.formatMessage('info', message, meta);
    console.log(formatted);
    this.writeToFile(`daily/${format(new Date(), 'yyyy-MM-dd')}.log`, formatted);
  }

  warn(message: string, meta?: unknown): void {
    if (!this.shouldLog('warn')) return;
    const formatted = this.formatMessage('warn', message, meta);
    console.warn(formatted);
    this.writeToFile(`daily/${format(new Date(), 'yyyy-MM-dd')}.log`, formatted);
  }

  error(message: string, meta?: unknown): void {
    if (!this.shouldLog('error')) return;
    const formatted = this.formatMessage('error', message, meta);
    console.error(formatted);
    this.writeToFile(`daily/${format(new Date(), 'yyyy-MM-dd')}.log`, formatted);
    this.writeToFile(`errors/${format(new Date(), 'yyyy-MM-dd')}.log`, formatted);
  }

  logWorkflowStart(): void {
    const separator = '='.repeat(80);
    const message = `\n${separator}\nWorkflow Started: ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}\n${separator}\n`;
    console.log(message);
    this.writeToFile(`daily/${format(new Date(), 'yyyy-MM-dd')}.log`, message);
  }

  logWorkflowEnd(success: boolean): void {
    const separator = '='.repeat(80);
    const status = success ? 'SUCCESS' : 'FAILED';
    const message = `\n${separator}\nWorkflow ${status}: ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}\n${separator}\n`;
    console.log(message);
    this.writeToFile(`daily/${format(new Date(), 'yyyy-MM-dd')}.log`, message);
  }
}
