export const apps = [
    {
      name: 'casca-master-orchestrator',
      script: './node_modules/.bin/tsx',
      args: 'scripts/master-orchestrator.ts',
      cwd: '/Users/victoryves/Documents/personal/Vibe Coding/casca-automation-blog',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Toronto',
      },
      error_file: './logs/master-orchestrator-error.log',
      out_file: './logs/master-orchestrator-out.log',
      merge_logs: true,
    },
  ];
