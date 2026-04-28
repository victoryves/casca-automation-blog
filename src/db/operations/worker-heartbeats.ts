import { query } from '../client.js';
import type { WorkerHeartbeat } from '../../types/index.js';

export const workerHeartbeatOps = {
  async touch(agentName: string, detail?: string, pid = process.pid): Promise<void> {
    query.run(
      `INSERT INTO worker_heartbeats (agent_name, last_heartbeat, pid, detail, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_name) DO UPDATE SET
         last_heartbeat = excluded.last_heartbeat,
         pid = excluded.pid,
         detail = excluded.detail,
         updated_at = excluded.updated_at`,
      [agentName, new Date().toISOString(), pid, detail ?? null, new Date().toISOString()]
    );
  },

  async clear(agentName: string): Promise<void> {
    query.run(
      `UPDATE worker_heartbeats
       SET last_heartbeat = NULL,
           detail = 'stopped',
           updated_at = ?
       WHERE agent_name = ?`,
      [new Date().toISOString(), agentName]
    );
  },

  async findAll(): Promise<WorkerHeartbeat[]> {
    return query.all<WorkerHeartbeat>(
      `SELECT *
       FROM worker_heartbeats
       ORDER BY agent_name ASC`
    );
  },

  async findByAgentName(agentName: string): Promise<WorkerHeartbeat | null> {
    const row = query.get<WorkerHeartbeat>(
      `SELECT * FROM worker_heartbeats WHERE agent_name = ?`,
      [agentName]
    );
    return row ?? null;
  },

  async findStale(staleBeforeIso: string): Promise<WorkerHeartbeat[]> {
    return query.all<WorkerHeartbeat>(
      `SELECT *
       FROM worker_heartbeats
       WHERE last_heartbeat IS NULL OR last_heartbeat < ?
       ORDER BY last_heartbeat ASC`,
      [staleBeforeIso]
    );
  },
};
