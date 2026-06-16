// PM2 process config for the Next.js app on the VPS.
//
// Secrets are NOT defined here — `next start` loads them from `.env.local` /
// `.env.production` in `cwd`. Adjust `cwd` and `PORT` for your server.
//
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: "norne-chatbot",
      cwd: "/var/www/norne-chatbot",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
    },
  ],
};
