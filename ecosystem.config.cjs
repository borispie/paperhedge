// pm2 配置：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    { name: 'pf-worker', script: 'server/worker.mjs', node_args: '--no-warnings', autorestart: true, max_restarts: 50, restart_delay: 5000, time: true },
    { name: 'pf-api', script: 'server/api.mjs', node_args: '--no-warnings', autorestart: true, time: true },
  ],
};
