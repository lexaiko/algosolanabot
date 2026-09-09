module.exports = {
  apps: [{
    name: 'solana-tradingbot',
    cwd: './',
    script: './node_modules/tsx/dist/cli.mjs',
    args: 'src/index.ts',
    interpreter: 'node',
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    restart_delay: 3000,
    time: true
  }]
};
