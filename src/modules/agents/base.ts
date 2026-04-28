import fs from 'node:fs/promises';
import path from 'node:path';

import { workerHeartbeatOps } from '../../db/operations/index.js';

export interface AgentTickResult {
  worked: boolean;
  detail: string;
  sleepMs?: number;
}

export interface AgentOptions {
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  singlePassHeartbeatGraceMinutes?: number;
}

export abstract class BaseAgent {
  private shuttingDown = false;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly singlePassHeartbeatGraceMinutes: number;
  private readonly logPath: string;

  protected constructor(
    protected readonly agentName: string,
    options: AgentOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 10 * 60 * 1000;
    this.singlePassHeartbeatGraceMinutes = options.singlePassHeartbeatGraceMinutes ?? 30;
    this.logPath = path.join(process.cwd(), 'logs', 'agents', `${this.agentName}.jsonl`);
    this.installSignalHandlers();
  }

  protected abstract tick(): Promise<AgentTickResult>;

  async runSinglePass(): Promise<AgentTickResult> {
    await this.touchHeartbeat('single-pass');
    try {
      const result = await this.tick();
      await this.touchHeartbeat(
        `${result.detail};single-pass-grace:${this.singlePassHeartbeatGraceMinutes}m`
      );
      await this.log('info', 'single-pass', this.toPayload(result));
      return result;
    } catch (error) {
      await this.log('error', 'single-pass-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await workerHeartbeatOps.clear(this.agentName);
      throw error;
    }
  }

  async start(): Promise<void> {
    let backoffMs = this.pollIntervalMs;
    await this.log('info', 'agent-start', {
      pollIntervalMs: this.pollIntervalMs,
      maxBackoffMs: this.maxBackoffMs,
    });

    while (!this.shuttingDown) {
      await this.touchHeartbeat('loop');
      try {
        const result = await this.tick();
        backoffMs = this.pollIntervalMs;
        await this.touchHeartbeat(result.detail);
        await this.log('info', 'tick-complete', this.toPayload(result));
        await this.sleep(result.sleepMs ?? this.pollIntervalMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = this.isRetryableError(message);
        await this.log(retryable ? 'warn' : 'error', 'tick-failed', {
          error: message,
          retryable,
          backoffMs,
        });

        await this.touchHeartbeat(`error:${message.slice(0, 180)}`);
        await this.sleep(backoffMs);
        if (retryable) {
          backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        } else {
          backoffMs = this.pollIntervalMs;
        }
      }
    }
  }

  protected async touchHeartbeat(detail: string): Promise<void> {
    await workerHeartbeatOps.touch(this.agentName, detail, process.pid);
  }

  protected async log(level: 'info' | 'warn' | 'error', event: string, payload: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      level,
      agent: this.agentName,
      event,
      pid: process.pid,
      ...payload,
    };
    await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  protected formatWorkflowDate(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private toPayload(result: AgentTickResult): Record<string, unknown> {
    return {
      worked: result.worked,
      detail: result.detail,
      sleepMs: result.sleepMs,
    };
  }

  private installSignalHandlers(): void {
    const handleSignal = async (signal: NodeJS.Signals) => {
      this.shuttingDown = true;
      await this.log('info', 'signal', { signal });
      await workerHeartbeatOps.clear(this.agentName);
      process.exit(0);
    };

    process.once('SIGINT', () => {
      void handleSignal('SIGINT');
    });
    process.once('SIGTERM', () => {
      void handleSignal('SIGTERM');
    });
  }

  private isRetryableError(message: string): boolean {
    return /403|econnreset|timeout|socket hang up|network/i.test(message);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.shuttingDown) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
